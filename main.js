const { App, Plugin, PluginSettingTab, Setting, Notice, Modal, TFile } = require('obsidian');

const HAND_TRAPS = [
    'Ash Blossom & Joyous Spring', 'Maxx "C"', 'Effect Veiler',
    'Nibiru, the Primal Being', 'Droll & Lock Bird', 'Ghost Ogre & Snow Rabbit',
    'Ghost Belle & Haunted Mansion',
    // Non-monster staples that function as instant-speed disruption rather
    // than combo pieces. Not "hand traps" in the strict monster sense, but
    // classifyCardRole treats this list as "disruption, not a combo piece"
    // (see its comment above), and these belong in that bucket too — without
    // this they fell through to the generic "Other" catch-all instead.
    'Infinite Impermanence', 'Called by the Grave', 'Torrential Tribute',
    'Crossout Designator', 'Solemn Judgment', 'Compulsory Evacuation Device',
];

// The rarity DB used to live here as a hardcoded object. It's now shipped as
// md-rarities.json (loaded in Plugin.onload → loadDataFiles) so it can be
// edited without touching code. This is the last-resort fallback if that
// file is missing or fails to parse.
const MD_RARITY_FALLBACK = {};

// Copy limit implied by a Master Duel banlist status.
const BANLIST_COPY_LIMIT = {
    'Forbidden': 0, 'Limited 1': 1, 'Limited 2': 2, 'Unlimited': 3
};

// The auto-fetched banlist (see YugiohPlugin.fetchLatestBanlist) is keyed by
// Konami ID with a raw copies-allowed value (0/1/2) rather than a status
// string — this converts one to the other.
const BANLIST_VALUE_TO_STATUS = { 0: 'Forbidden', 1: 'Limited 1', 2: 'Limited 2' };

// Community-maintained, auto-updating (daily) Master Duel limit-regulation
// feed from the YAML Yugi project — see
// https://github.com/DawnbrandBots/yaml-yugi-limit-regulation. Keyed by
// Konami ID, not card name, so no name-resolution step is needed: we just
// cross-reference each fetched card's own konami_id (already returned by
// YGOPRODeck's misc=yes) against this.
const BANLIST_SOURCE_URL = 'https://dawnbrandbots.github.io/yaml-yugi-limit-regulation/master-duel/current.vector.json';

// If the plugin hasn't been able to refresh the banlist (e.g. no internet)
// for this many days, checkBanlistFreshness() surfaces a Notice so a long
// offline stretch doesn't go unnoticed.
const BANLIST_STALE_DAYS = 30;

const DEFAULT_SETTINGS = { collectionNotePath: 'Yu-Gi-Oh Collection.md' };

// ── Shared line/section helpers ──────────────────────────────────────────────
// Recognizes both checkbox styles: "- [ ]"/"- [x]" and "- ☐"/"- ☑".
const CHECKBOX_RE = /^(-\s*)(\[[ xX]\]|☐|☑)(\s*)(.*)$/;
function isChecked(marker) { return marker === '☑' || marker.toLowerCase() === '[x]'; }
function setChecked(line, checked) {
    const m = line.match(CHECKBOX_RE);
    if (!m) return line;
    const newMarker = m[2].startsWith('[') ? `[${checked ? 'x' : ' '}]` : (checked ? '☑' : '☐');
    return `${m[1]}${newMarker}${m[3]}${m[4]}`;
}
function detectEOL(content) { return content.includes('\r\n') ? '\r\n' : '\n'; }
function splitLines(content) { return content.split(/\r\n|\n/); }

// Returns the group this heading EXPLICITLY changes to, or null to inherit parent.
// Returning 'other' means "reset to no group" (budget/checklist/combo sections).
function explicitGroup(heading) {
    const h = heading.toLowerCase().replace(/[^\w\s]/g, ' '); // strip emoji/punct

    // 40-card / variant block — HIGHEST priority. Must run before the budget/checklist
    // reset so a heading like "40-CARD PURE Archtype VARIANT (CHECKLIST)" is
    // correctly classified as main40 and not discarded as 'other'.
    if (/\b(40\s*card|40\s*-\s*card|variant)\b/.test(h)) return 'main40';

    // Budget / checklist / combo / step sections — explicitly reset to 'other' so
    // their cards don't bleed into a deck group via inheritance.
    if (/\b(budget|checklist|step\s*\d|craft|cost|calculator|combo|win|loss|tracker|banlist|notes?)\b/.test(h)) return 'other';

    // Extra deck top-level block
    if (/\bextra\s*deck\b/.test(h)) return 'extra';

    // Extra deck card types as standalone short headings (e.g. "## 🔥 Fusion")
    const stripped = h.replace(/\s+/g, ' ').trim();
    if (/^[#\s]*(fusion|link|xyz|synchro|pendulum|ritual)\s*(\(\d+\))?\s*$/.test(stripped)) return 'extra';

    // Main deck top-level block — only a true top-level heading (# or ##)
    // should set main60. Sub-headings (### or ####) inside a variant/40-card
    // block must inherit the parent group instead of resetting to main60.
    if (/\bmain\s*deck\b/.test(h)) {
        if (/\b40\b/.test(h)) return 'main40'; // "Main Deck (40)" → variant
        const depth = (heading.match(/^(#{1,4})/) || ['', ''])[1].length;
        if (depth <= 2) return 'main60'; // top-level: always main60
        return null; // sub-heading — inherit parent (could be main40 or extra)
    }

    return null; // inherit from parent
}

// Walks every line once and returns a parallel array: for each line index,
// the deck group it belongs to ('main60' | 'main40' | 'extra' | 'other') or
// null for lines before any heading. A heading only changes the group when it
// sits at or above the depth that started the current group (deeper headings
// like "### Engine" inside "# MAIN DECK" just inherit); an unmatched heading
// at that depth resets to 'other' so e.g. a BUDGET/COMBO block doesn't bleed
// into the deck lists above it.
function computeLineGroups(lines) {
    const groups = new Array(lines.length).fill(null);
    let currentGroup = 'other';
    let currentDepth = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const hm = line.match(/^(#{1,4})\s+.*/);
        if (hm) {
            const depth = hm[1].length;
            if (currentDepth === 0 || depth <= currentDepth) {
                const explicit = explicitGroup(line);
                currentGroup = explicit !== null ? explicit : 'other';
                currentDepth = depth;
            }
            groups[i] = currentGroup;
            continue;
        }
        groups[i] = currentGroup;
    }
    return groups;
}

// A card-list line, loosely: optional checkbox, then free text. Count and
// rarity are NOT required — real deck lists are often just "- [ ] Card Name".
const CARD_LINE_RE = /^-\s*(?:(\[[ xX]\]|☐|☑)\s+)?(.+)$/;

// Markdown horizontal-rule dividers ("---", "----", etc., used between
// sections) would otherwise match CARD_LINE_RE too — "-" is technically a
// valid (degenerate) card name under that regex, so a divider line parses as
// a bare card called "--". That created a phantom card entry AND, worse,
// made insertion logic treat the divider as "the last card line" in a
// section, splicing newly-added cards in right after the "---" instead of
// after the real last card. isCardLine() is the guarded check to use
// anywhere CARD_LINE_RE is used to identify an actual card line.
const HR_RE = /^-{3,}\s*$/;
function isCardLine(line) {
    return CARD_LINE_RE.test(line) && !HR_RE.test(line.trim());
}

// Returns the Monster/Spell/Trap bucket this heading EXPLICITLY changes to,
// or null to inherit from its parent heading. Mirrors explicitGroup's
// depth-based reset logic, but for the Monsters/Spells/Traps subsections
// within a deck group rather than the main60/main40/extra groups themselves.
function explicitTypeGroup(heading) {
    const h = heading.toLowerCase().replace(/[^\w\s]/g, ' ');
    if (/\bmonster/.test(h)) return 'Monster';
    if (/\bspell/.test(h)) return 'Spell';
    if (/\btrap/.test(h)) return 'Trap';
    return null;
}

// Walks every line once and returns a parallel array: for each line index,
// the card-type bucket ('Monster' | 'Spell' | 'Trap' | null) implied by the
// nearest Monsters/Spells/Traps heading above it. A sub-heading deeper than
// the one that set the current bucket inherits it (e.g. "### Hand Traps"
// nested under "## Monsters" is still 'Monster'); a heading at the same or
// shallower depth that doesn't match resets to null.
function computeTypeGroups(lines) {
    const typeGroups = new Array(lines.length).fill(null);
    let currentType = null;
    // Infinity = "no bucket active" — lets the next heading, at ANY depth,
    // take effect. Without this, a non-matching parent heading (e.g. "#
    // MAIN DECK", which sets type=null) permanently locks currentDepth at
    // its own level, so a deeper "## Monsters" heading nested under it is
    // treated as "too deep to matter" and never gets to set the bucket —
    // typeGroups ends up null for the whole file.
    let currentDepth = Infinity;
    for (let i = 0; i < lines.length; i++) {
        const hm = lines[i].match(/^(#{1,6})\s+.*/);
        if (hm) {
            const depth = hm[1].length;
            if (depth <= currentDepth) {
                currentType = explicitTypeGroup(lines[i]);
                // Only lock in this depth when a bucket was actually matched.
                // Otherwise stay "open" so a deeper heading can still set it
                // (fixes Monsters/Spells/Traps under a non-matching parent
                // like "# MAIN DECK"), while a heading that DID match still
                // correctly blocks deeper false-positives like "### Hand
                // Traps" (nested under Monsters) from flipping to Trap.
                currentDepth = currentType !== null ? depth : Infinity;
            }
            continue;
        }
        typeGroups[i] = currentType;
    }
    return typeGroups;
}

// Splits the free text of a card line into { name, count, rarity }. Accepts
// a trailing count ("Name ×3", "Name x3", "Name x2-3") OR a leading count
// ("3x Name"), and an optional trailing rarity tag ("Name [SR]"), in any
// combination — none of them are required.
function parseEntryText(raw) {
    let text = raw.trim();

    // Strip a trailing completion-date marker (e.g. added by the Tasks plugin
    // or a "done" hotkey when a checkbox is ticked: "✅ 2026-07-23"). Without
    // this, the rarity/count regexes below — which anchor to the true end of
    // the line — stop matching once a date is appended after "[UR]", and the
    // whole tail (count, rarity, date) gets swallowed into the card name,
    // breaking lookup for that card everywhere (grid, stats, re-saving).
    text = text.replace(/\s*[✅✔️]\uFE0F?\s*\d{4}-\d{2}-\d{2}\s*$/, '').trim();

    let rarity = null;

    const rarityMatch = text.match(/\s*\[([A-Z]{1,3})\]\s*$/);
    if (rarityMatch) {
        rarity = rarityMatch[1];
        text = text.slice(0, rarityMatch.index).trim();
    }

    let m = text.match(/^(.+?)\s*[×xX](\d+)(?:[–—-]\d+)?$/);
    if (m) return { name: m[1].trim(), count: parseInt(m[2], 10), rarity };

    m = text.match(/^(\d+)\s*[xX]\s+(.+)$/);
    if (m) return { name: m[2].trim(), count: parseInt(m[1], 10), rarity };

    return { name: text, count: 1, rarity };
}

const SKIP_WORDS = ['additional', 'budget', 'tech', 'none', 'optional', 'cards'];

// Parse cards from markdown - section-aware, dual-format.
// Returns entries tagged with deckGroup: 'main60' | 'main40' | 'extra'.
// Handles both "- [ ] Name" / "- ☑ Name" checkbox lines (with or without a
// count / rarity tag) and bare "- Name" lines. Bare lines (no checkbox) are
// treated as owned=true (they are the actual deck list).
function parseCardsFromMarkdown(content) {
    const lines = splitLines(content);
    const groups = computeLineGroups(lines);

    // Within a group, prefer entries that carry an explicit rarity tag over a
    // bare one, and prefer richer groups (main60/extra/main40) over 'other'
    // (budget/checklist mentions of the same card) when merging rarity info.
    const cardMap = new Map();

    for (let i = 0; i < lines.length; i++) {
        const group = groups[i];
        if (!group) continue;

        if (!isCardLine(lines[i])) continue;
        const m = lines[i].match(CARD_LINE_RE);

        const checkboxMarker = m[1];
        const { name, count, rarity } = parseEntryText(m[2]);
        if (!name || name.length < 2) continue;

        const lower = name.toLowerCase();
        if (SKIP_WORDS.some(w => lower.includes(w))) continue;

        const owned = checkboxMarker === undefined ? true : isChecked(checkboxMarker);
        const key = `${group}:${name}`;

        if (!cardMap.has(key)) {
            cardMap.set(key, { name, rarity: rarity || 'N', count, owned, deckGroup: group });
        } else if (cardMap.get(key).rarity === 'N' && rarity) {
            cardMap.set(key, { ...cardMap.get(key), rarity });
        }
    }

    // Second pass: apply rarity upgrades from 'other' (budget checklists) to deck groups.
    const otherEntries = Array.from(cardMap.values()).filter(e => e.deckGroup === 'other');
    for (const other of otherEntries) {
        if (other.rarity === 'N') continue;
        for (const g of ['main60', 'main40', 'extra']) {
            const key = `${g}:${other.name}`;
            if (cardMap.has(key) && cardMap.get(key).rarity === 'N') {
                cardMap.set(key, { ...cardMap.get(key), rarity: other.rarity });
            }
        }
    }

    // Return only real deck groups (exclude 'other' — budget/checklist cards)
    return Array.from(cardMap.values()).filter(e => e.deckGroup !== 'other');
}

// Parse combo checklists from markdown.
// Finds all headings under any "COMBO" section and returns:
//   { category: string, text: string, learned: boolean, rawText: string }[]
// rawText is the original line as written (used for checkbox toggling).
function parseCombosFromMarkdown(content) {
    const combos = [];

    // Split into sections by any heading
    const sectionRe = /^(#{1,6}[^#\n].*)$/gm;
    const sections = [];
    let lastIndex = 0, lastHeading = 'top', sm;
    while ((sm = sectionRe.exec(content)) !== null) {
        sections.push({ heading: lastHeading, body: content.slice(lastIndex, sm.index) });
        lastHeading = sm[1];
        lastIndex = sm.index + sm[0].length;
    }
    sections.push({ heading: lastHeading, body: content.slice(lastIndex) });

    // Walk sections tracking whether we're inside a COMBO block.
    // Reset rules:
    //   - A # (depth=1) non-combo heading always exits combo mode.
    //   - A ## (depth=2) non-combo heading exits combo mode ONLY if the combo
    //     heading itself was also depth<=2 (i.e. we don't want ## sub-categories
    //     to exit a # COMBO block).
    let inCombo = false;
    let comboHeadingDepth = 0;
    let category = '';

    sections.forEach(s => {
        const h = s.heading.toLowerCase().replace(/[^\w\s]/g, ' ');
        const depth = (s.heading.match(/^(#{1,6})/) || ['', ''])[1].length;

        // Entering a combo block
        if (/\bcombo\b/.test(h)) {
            inCombo = true;
            comboHeadingDepth = depth;
            category = s.heading.replace(/^#{1,6}\s*/, '').trim();
            // Also parse any checkbox items directly under the combo heading
            const lineRe = /^- \[([x ])\] (.+)$/gm;
            let m;
            while ((m = lineRe.exec(s.body)) !== null) {
                combos.push({ category, text: m[2].trim(), learned: m[1] === 'x', rawText: m[0] });
            }
            return;
        }

        if (!inCombo) return;

        // A heading at the same depth or shallower as the combo block heading resets context
        if (depth <= comboHeadingDepth) {
            inCombo = false;
            return;
        }

        // A deeper sub-heading becomes the current category label, then parse its body
        category = s.heading.replace(/^#{1,6}\s*/, '').trim();
        const lineRe = /^- \[([x ])\] (.+)$/gm;
        let m;
        while ((m = lineRe.exec(s.body)) !== null) {
            combos.push({ category, text: m[2].trim(), learned: m[1] === 'x', rawText: m[0] });
        }
    });

    return combos;
}

// Toggle a combo checkbox in the markdown file
function updateComboCheckbox(content, rawText, learned) {
    const escaped = rawText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('- \\[[ x]\\] ' + escaped.slice(6)); // strip "- [x] " prefix
    // Simpler: just replace the exact raw line
    const oldLine = rawText;
    const newLine = rawText.replace(/^- \[[ x]\]/, learned ? '- [x]' : '- [ ]');
    return content.split(oldLine).join(newLine);
}




// Toggle a card's checkbox in the markdown. Matches the line by its parsed
// name (count/rarity-agnostic) rather than requiring an exact "×N [RARITY]"
// suffix, and skips 'other' (budget/combo/etc.) lines so a card mentioned in
// a checklist elsewhere doesn't get toggled by mistake.
function updateCardCheckbox(content, cardName, owned) {
    const eol = detectEOL(content);
    const lines = splitLines(content);
    const groups = computeLineGroups(lines);
    const target = cardName.trim().toLowerCase();

    const updated = lines.map((line, i) => {
        const group = groups[i];
        if (!group || group === 'other') return line;

        const m = line.match(CARD_LINE_RE);
        if (!m) return line;
        const { name } = parseEntryText(m[2]);
        if (name.toLowerCase() !== target) return line;

        if (m[1] === undefined) {
            // Bare line with no checkbox yet — add one.
            return line.replace(/^(-\s*)/, `$1[${owned ? 'x' : ' '}] `);
        }
        return setChecked(line, owned);
    });

    return updated.join(eol);
}

// Appends a newly-added card at the end of its deck section (after the last
// existing checklist item in that section, including nested sub-headings),
// creating the section at the end of the note if it doesn't exist yet.
function appendCardToSection(content, card) {
    const eol = detectEOL(content);
    const lines = splitLines(content);
    const groups = computeLineGroups(lines);
    const typeGroups = computeTypeGroups(lines);
    const groupKey = ['main60', 'main40', 'extra'].includes(card.deckGroup) ? card.deckGroup : 'main60';

    const rarity = card.rarity || 'N';
    const count = card.count || 1;
    const newLine = `- [${card.owned ? 'x' : ' '}] ${card.name} ×${count} [${rarity}]`;

    // Prefer inserting into the matching Monster/Spell/Trap subsection within
    // this deck group. Without this, a new card just gets appended after
    // whichever card line happens to be last in the whole group — which is
    // usually the Traps section — regardless of the new card's actual type.
    const cardType = card.type?.includes('Trap') ? 'Trap'
        : card.type?.includes('Spell') ? 'Spell'
        : 'Monster';

    let lastIdxInType = -1;
    let headingIdxForType = -1;
    for (let i = 0; i < lines.length; i++) {
        if (groups[i] !== groupKey) continue;
        if (typeGroups[i] === cardType && isCardLine(lines[i])) lastIdxInType = i;
        if (headingIdxForType === -1 && groups[i] === groupKey && /^#{1,6}\s/.test(lines[i]) && explicitTypeGroup(lines[i]) === cardType) {
            headingIdxForType = i;
        }
    }
    if (lastIdxInType !== -1) {
        lines.splice(lastIdxInType + 1, 0, newLine);
        return lines.join(eol);
    }
    if (headingIdxForType !== -1) {
        lines.splice(headingIdxForType + 1, 0, newLine);
        return lines.join(eol);
    }

    // No matching Monster/Spell/Trap subsection found (e.g. the Extra Deck,
    // which this template organizes by Fusion/Synchro/Xyz/Link instead) —
    // fall back to the previous behavior.
    let lastIdxInGroup = -1;
    let headingIdxForGroup = -1;
    for (let i = 0; i < lines.length; i++) {
        if (groups[i] === groupKey && isCardLine(lines[i])) lastIdxInGroup = i;
        if (headingIdxForGroup === -1 && /^#{1,4}\s/.test(lines[i]) && explicitGroup(lines[i]) === groupKey) {
            headingIdxForGroup = i;
        }
    }

    if (lastIdxInGroup !== -1) {
        lines.splice(lastIdxInGroup + 1, 0, newLine);
        return lines.join(eol);
    }
    if (headingIdxForGroup !== -1) {
        lines.splice(headingIdxForGroup + 1, 0, newLine);
        return lines.join(eol);
    }

    // Section doesn't exist at all yet — append a brand new one at the end.
    const HEADINGS = {
        main60: '# 🟦 MAIN DECK',
        main40: '# 🟢 40-CARD VARIANT',
        extra: '# 🟥 EXTRA DECK',
    };
    const trimmed = content.replace(/\s+$/, '');
    return `${trimmed}${eol}${eol}${HEADINGS[groupKey]}${eol}${newLine}${eol}`;
}

// Writes a card's current count to the template: rewrites the existing line
// in place if one's already there for this card+section (so re-adding a card
// bumps its ×N instead of creating a duplicate line), otherwise appends a new
// one via appendCardToSection. This is the one place that turns "the user hit
// Add" into a template change, so the note and the in-app count can't drift.
function upsertCardInTemplate(content, card) {
    const eol = detectEOL(content);
    const lines = splitLines(content);
    const groups = computeLineGroups(lines);
    const groupKey = ['main60', 'main40', 'extra'].includes(card.deckGroup) ? card.deckGroup : 'main60';
    const target = card.name.trim().toLowerCase();
    const count = card.count || 1;
    const rarity = card.rarity || 'N';

    for (let i = 0; i < lines.length; i++) {
        if (groups[i] !== groupKey) continue;
        const m = lines[i].match(CARD_LINE_RE);
        if (!m) continue;
        const { name } = parseEntryText(m[2]);
        if (name.toLowerCase() !== target) continue;

        const checkbox = m[1];
        const prefix = checkbox !== undefined ? `- ${checkbox} ` : '- ';
        lines[i] = `${prefix}${card.name} ×${count} [${rarity}]`;
        return lines.join(eol);
    }

    return appendCardToSection(content, card);
}

// Removes ONE copy of a card from its deck-group section in the markdown.
// Matches by parsed name (count/rarity-agnostic), scoped to the given deck
// group only — so removing "Ash Blossom" from the 40-card variant doesn't
// also touch the copy in the 60-card Main Deck if it's listed in both. If
// the line's count is >1, the line is rewritten with count-1; only when the
// count hits 0 is the line deleted entirely. Returns
// { content, removed, newCount } — removed is true only when the line was
// deleted (last copy). If no matching line is found, returns the content
// unchanged with removed: false.
function decrementCardInTemplate(content, cardName, deckGroup) {
    const eol = detectEOL(content);
    const lines = splitLines(content);
    const groups = computeLineGroups(lines);
    const target = cardName.trim().toLowerCase();

    const idx = lines.findIndex((line, i) => {
        if (groups[i] !== deckGroup) return false;
        const m = line.match(CARD_LINE_RE);
        if (!m) return false;
        const { name } = parseEntryText(m[2]);
        return name.toLowerCase() === target;
    });

    if (idx === -1) return { content, removed: false, newCount: 0 };

    const m = lines[idx].match(CARD_LINE_RE);
    const { name, count, rarity } = parseEntryText(m[2]);
    const newCount = count - 1;

    if (newCount <= 0) {
        lines.splice(idx, 1);
        return { content: lines.join(eol), removed: true, newCount: 0 };
    }

    const checkbox = m[1];
    const prefix = checkbox !== undefined ? `- ${checkbox} ` : '- ';
    lines[idx] = `${prefix}${name} ×${newCount} [${rarity}]`;
    return { content: lines.join(eol), removed: false, newCount };
}

// ── Collection note (owned-card tracking, independent of any deck) ────────
// Unlike deck notes, the collection note is a flat list — no deck-group or
// Monster/Spell/Trap sections, just "- Card Name ×N [RARITY]" lines anywhere
// in the file (rarity tag optional, defaults to N). Grouping by rarity for
// display happens in the UI, not the file structure, so this reuses
// CARD_LINE_RE/parseEntryText directly with no heading-tracking needed.

// Parses every card line in a collection note into a Map keyed by lowercase
// name. If the same card appears on more than one line, counts are summed
// and a real rarity tag (if any) wins over a missing/default one.
function parseCollectionFromMarkdown(content) {
    const lines = splitLines(content);
    const map = new Map();
    for (const line of lines) {
        if (!isCardLine(line)) continue;
        const m = line.match(CARD_LINE_RE);
        const { name, count, rarity } = parseEntryText(m[2]);
        if (!name || name.length < 2) continue;
        const key = name.toLowerCase();
        if (map.has(key)) {
            const existing = map.get(key);
            existing.count += count;
            if (existing.rarity === 'N' && rarity && rarity !== 'N') existing.rarity = rarity;
        } else {
            map.set(key, { name, count, rarity: rarity || 'N' });
        }
    }
    return map;
}

// Rewrites a card's line to the given count if it already exists anywhere
// in the collection note, otherwise appends a new line right after the last
// existing card line (or at the end of the file if there are none yet).
function upsertCollectionCard(content, cardName, rarity, count) {
    const eol = detectEOL(content);
    const lines = splitLines(content);
    const target = cardName.trim().toLowerCase();
    let lastCardIdx = -1;

    for (let i = 0; i < lines.length; i++) {
        if (!isCardLine(lines[i])) continue;
        lastCardIdx = i;
        const m = lines[i].match(CARD_LINE_RE);
        const { name } = parseEntryText(m[2]);
        if (name.toLowerCase() !== target) continue;
        lines[i] = `- ${cardName} ×${count} [${rarity || 'N'}]`;
        return lines.join(eol);
    }

    const newLine = `- ${cardName} ×${count} [${rarity || 'N'}]`;
    if (lastCardIdx !== -1) {
        lines.splice(lastCardIdx + 1, 0, newLine);
        return lines.join(eol);
    }
    const trimmed = content.replace(/\s+$/, '');
    return `${trimmed}${eol}${newLine}${eol}`;
}

// Removes ONE copy of a card anywhere in the collection note — decrements
// ×N, or deletes the line once the last copy is gone. Same
// { content, removed, newCount } shape as decrementCardInTemplate.
function decrementCollectionCard(content, cardName) {
    const eol = detectEOL(content);
    const lines = splitLines(content);
    const target = cardName.trim().toLowerCase();

    const idx = lines.findIndex(line => {
        if (!isCardLine(line)) return false;
        const m = line.match(CARD_LINE_RE);
        const { name } = parseEntryText(m[2]);
        return name.toLowerCase() === target;
    });

    if (idx === -1) return { content, removed: false, newCount: 0 };

    const m = lines[idx].match(CARD_LINE_RE);
    const { name, count, rarity } = parseEntryText(m[2]);
    const newCount = count - 1;

    if (newCount <= 0) {
        lines.splice(idx, 1);
        return { content: lines.join(eol), removed: true, newCount: 0 };
    }

    lines[idx] = `- ${name} ×${newCount} [${rarity}]`;
    return { content: lines.join(eol), removed: false, newCount };
}

const COLLECTION_TEMPLATE = `# 📦 MY COLLECTION
> Every card you own, one line each — "- Card Name ×3 [UR]". Rarity tag is optional (defaults to N). Edit directly, or use the "📦 Open Collection Manager" command to add/remove cards from the UI.

---

`;

const DECK_TEMPLATE = `# 🐉 Deck Template – Master Duel (Obsidian)
> Reusable Obsidian template for decks in Master Duel. Clean version with no cards, ready to customize.

---

## 📦 Deck Metadata (edit per deck)
\`\`\`yaml
deck: 
variant: 
format: Master Duel
main: 
extra: 
status: 
\`\`\`

---

# 🟦 CHECKLIST LEGEND
- **[UR]** Ultra Rare  
- **[SR]** Super Rare  
- **[R]** Rare  
- **[N]** Normal

Use ☑ / ☐ to track ownership or crafting.

---

# 🟣 BUDGET CRAFTING CHECKLIST

## 🔹 STEP 1 — Core Engine
- 

## 🔹 STEP 2 — Mandatory Extra Deck
- 

## 🔹 STEP 3 — Staples
- 

## 🔹 STEP 4 — Engine / Extensions
- 

## 🔹 STEP 5 — Finishers / Luxury
- 

---

# 🟦 MAIN DECK

## 🧩 Monsters

### 🟣 Engine
- 

### ⚪ Secondary Engine
- 

### ✋ Hand Traps
- 

---

## ✨ Spells
- 

---

## 🪤 Traps
- 

---

# 🟥 EXTRA DECK

## 🔥 Fusion
- 

## 🔗 Link
- 

## 🎵 Synchro
- 

## ⭐ Xyz
- 

---

# 🟢 40-CARD VARIANT

## Main Deck (40)
### Monsters
- 

### Spells
- 

### Traps
- 

---

# 🧠 COMBO CHECKLIST (TICK WHEN LEARNED)
- [ ] 
- [ ] 
- [ ] 

---

# 🏷️ OBSIDIAN TAGS
\`\`\`
#yugioh #masterduel #decktemplate
\`\`\`

---

# 📊 WIN / LOSS TRACKER

| Date | Opponent Deck | Going 1st/2nd | Result (W/L) | Notes |
|------|---------------|---------------|-------------|-------|
|      |               |               |             |       |

---

# 🔄 BANLIST CHANGE NOTES

## Current Notes
- Date:
- Banlist Version:
- Changes affecting this deck:

## Impact Assessment
- Engine affected:
- Cards to cut:
- Cards to add:
- Power level change: ⬆ / ⬇ / =

---

# 💸 UR DUST COST CALCULATOR

## Core URs (Must-have)
- 

## Staples
- 

## Power / Engine URs
- 

---

# 🧮 TOTAL ESTIMATED UR COST
- 

---

# 📝 NOTES / CUSTOMIZATION
- Duplicate this note per deck
- Track combos and improvements
- Adjust based on your collection
`;

class YugiohPlugin extends Plugin {
    async onload() {
        await this.loadSettings();
        await this.loadDataFiles();
        this.addSettingTab(new YugiohSettingTab(this.app, this));
        this.addCommand({
            id: 'open-deck-ui',
            name: '🐉 Open Deck Builder',
            callback: () => new DeckUI(this.app, this).open()
        });
        this.addCommand({
            id: 'create-deck-template',
            name: '📄 Create Deck Template in Templates folder',
            callback: () => this.createDeckTemplate()
        });
        this.addCommand({
            id: 'open-collection-ui',
            name: '📦 Open Collection Manager',
            callback: () => new CollectionUI(this.app, this).open()
        });
        this.addCommand({
            id: 'open-collection-note',
            name: '📦 Open Collection Note (edit directly)',
            callback: () => this.openCollectionNote()
        });
        this.addCommand({
            id: 'create-collection-note',
            name: '📦 Create Collection Note',
            callback: () => this.createCollectionNote()
        });
        this.addCommand({
            id: 'reload-yugioh-data-files',
            name: '🔄 Reload rarity/banlist data files',
            callback: () => this.loadDataFiles(true)
        });
        this.addCommand({
            id: 'update-banlist',
            name: '🔄 Check for Master Duel Banlist Update',
            callback: () => this.updateBanlistFromSource(true)
        });
        // Auto-refresh the Master Duel banlist in the background on every
        // launch. It's one small request to a daily-updated community feed
        // (see fetchLatestBanlist) — no manual monthly update needed. If
        // it's offline or the source is down, this fails silently and keeps
        // whatever was last cached; checkBanlistFreshness() below is the
        // backstop that surfaces a Notice if that drags on too long.
        this.autoUpdateBanlist();
        this.checkBanlistFreshness();
    }

    // Fetches the current Master Duel limit regulation vector. Returns
    // { ok: true, date, regulation } on success, or { ok: false, error }
    // — never throws, since this runs unattended on every launch.
    async fetchLatestBanlist() {
        try {
            const res = await fetch(BANLIST_SOURCE_URL);
            if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
            const data = await res.json();
            if (!data || typeof data.regulation !== 'object' || !data.date) {
                return { ok: false, error: 'Unexpected response shape' };
            }
            return { ok: true, date: data.date, regulation: data.regulation };
        } catch (err) {
            return { ok: false, error: err.message };
        }
    }

    // Writes a freshly-fetched regulation vector to md-banlist.json and
    // reloads it live.
    async applyBanlistResult(result, notify) {
        const fileContent = {
            _meta: {
                format: 'Master Duel',
                asOf: result.date,
                source: BANLIST_SOURCE_URL,
                note: 'Auto-fetched from the YAML Yugi limit-regulation project (community-maintained, updated daily: https://github.com/DawnbrandBots/yaml-yugi-limit-regulation). Keyed by Konami ID; value is copies allowed per deck (0=Forbidden, 1=Limited, 2=Semi-Limited).'
            },
            regulation: result.regulation
        };
        const success = await this.writeDataFile('md-banlist.json', JSON.stringify(fileContent, null, 4));
        if (!success) {
            if (notify) new Notice('❌ Failed to write md-banlist.json.');
            return false;
        }
        await this.loadDataFiles(false);
        return true;
    }

    // Shared by the silent auto-update and the manual "Check for Banlist
    // Update" command (notify=true shows a Notice either way, including
    // "already current").
    async updateBanlistFromSource(notify = false) {
        const result = await this.fetchLatestBanlist();
        if (!result.ok) {
            if (notify) new Notice(`❌ Couldn't fetch the latest banlist: ${result.error}`);
            return false;
        }
        if (notify && this.banlistMeta?.asOf === result.date) {
            new Notice(`✅ Banlist already current (dated ${result.date}).`);
            return true;
        }
        const success = await this.applyBanlistResult(result, notify);
        if (success && notify) {
            new Notice(`✅ Banlist updated — ${Object.keys(result.regulation).length} entries, dated ${result.date}.`);
        }
        return success;
    }

    // Silent background version run on every launch: only writes/reloads
    // when the fetched date is actually new, and never shows a Notice for
    // "already current" or "offline" — those are the common case, not
    // something worth interrupting the user for.
    async autoUpdateBanlist() {
        const result = await this.fetchLatestBanlist();
        if (!result.ok || this.banlistMeta?.asOf === result.date) return;
        const updated = await this.applyBanlistResult(result, false);
        if (updated) {
            new Notice(`🔄 Master Duel banlist auto-updated to ${result.date}.`);
        }
    }

    // Reads md-rarities.json and md-banlist.json from the plugin's own folder
    // (via the vault adapter, NOT Node's fs — this keeps it working on mobile,
    // where isDesktopOnly: false promises support). Both are optional; a
    // missing/broken file just means "nothing known" for that lookup rather
    // than a load failure, so the plugin still works out of the box.
    async loadDataFiles(notify = false) {
        this.rarityDB = await this.readJsonFile('md-rarities.json', MD_RARITY_FALLBACK);
        const banlistFile = await this.readJsonFile('md-banlist.json', { regulation: {} });
        this.banlistRegulation = banlistFile.regulation || {};
        this.banlistMeta = banlistFile._meta || null;
        if (notify) {
            const n = Object.keys(this.rarityDB).length, b = Object.keys(this.banlistRegulation).length;
            new Notice(`🔄 Reloaded data: ${n} rarities, ${b} banlist entries`);
        }
    }

    async readJsonFile(fileName, fallback) {
        try {
            const path = `${this.manifest.dir}/${fileName}`;
            const raw = await this.app.vault.adapter.read(path);
            return JSON.parse(raw);
        } catch (err) {
            console.error(`[YugiohPlugin] Could not load ${fileName}, using fallback:`, err);
            return fallback;
        }
    }

    // Writes a plugin data file (e.g. md-banlist.json) via the vault adapter
    // — same mechanism readJsonFile uses, so this stays mobile-compatible.
    async writeDataFile(fileName, content) {
        try {
            const path = `${this.manifest.dir}/${fileName}`;
            await this.app.vault.adapter.write(path, content);
            return true;
        } catch (err) {
            console.error(`[YugiohPlugin] Could not write ${fileName}:`, err);
            return false;
        }
    }

    // Days since the banlist's _meta.asOf date, or null if that date is
    // missing/unparseable. Used for the startup staleness nag and to show
    // "X days old" in the Update Banlist modal and settings tab.
    getBanlistAgeDays() {
        const asOf = this.banlistMeta?.asOf;
        if (!asOf) return null;
        const then = new Date(asOf + 'T00:00:00');
        if (isNaN(then.getTime())) return null;
        return Math.floor((Date.now() - then.getTime()) / (1000 * 60 * 60 * 24));
    }

    // Nags if the banlist snapshot is older than BANLIST_STALE_DAYS —
    // autoUpdateBanlist() runs every launch, so this only fires when that
    // has been silently failing (e.g. no internet, or the source is down)
    // for a while, as a backstop so a long stale stretch doesn't go unnoticed.
    checkBanlistFreshness() {
        const days = this.getBanlistAgeDays();
        if (days === null || days < BANLIST_STALE_DAYS) return;
        new Notice(
            `⚠️ Master Duel banlist is ${days} days old (dated ${this.banlistMeta.asOf}) and couldn't auto-update. Check your connection, or run "🔄 Check for Master Duel Banlist Update".`,
            10000
        );
    }

    // Master Duel banlist status for a card, looked up by its own Konami
    // ID (from misc_info.konami_id) against the auto-fetched regulation
    // vector — no name-based lookup needed. Defaults to Unlimited when the
    // ID is missing or not present in the vector.
    getBanStatusMD(konamiId) {
        if (konamiId === undefined || konamiId === null) return 'Unlimited';
        const value = this.banlistRegulation?.[String(konamiId)];
        return BANLIST_VALUE_TO_STATUS[value] ?? 'Unlimited';
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    getActiveFile() {
        // Always use whatever note is currently open in the editor
        const file = this.app.workspace.getActiveFile();
        return file instanceof TFile ? file : null;
    }

    async readTemplate() {
        const file = this.getActiveFile();
        if (!file) return null;
        return await this.app.vault.read(file);
    }

    async writeTemplate(content) {
        const file = this.getActiveFile();
        if (!file) return false;
        await this.app.vault.modify(file, content);
        return true;
    }

    // ── Collection note I/O ────────────────────────────────────────────────
    // Unlike deck notes (which use whatever file is currently open), the
    // collection is a single fixed note at settings.collectionNotePath, so
    // it's readable/writable regardless of what the user has open.
    getCollectionFile() {
        const file = this.app.vault.getAbstractFileByPath(this.settings.collectionNotePath);
        return file instanceof TFile ? file : null;
    }

    async readCollection() {
        const file = this.getCollectionFile();
        if (!file) return null;
        return await this.app.vault.read(file);
    }

    async writeCollection(content) {
        const file = this.getCollectionFile();
        if (!file) return false;
        await this.app.vault.modify(file, content);
        return true;
    }

    // Lightweight parse of the collection note (name/count/rarity only, no
    // YGOPRODeck fetch) for cross-referencing "have vs need" in the Deck
    // Builder without slowing deck loads down. Returns an empty Map if no
    // collection note exists yet.
    async loadCollectionMap() {
        const content = await this.readCollection();
        if (content === null) return new Map();
        return parseCollectionFromMarkdown(content);
    }

    async createCollectionNote() {
        const path = this.settings.collectionNotePath;
        const vault = this.app.vault;
        const existing = vault.getAbstractFileByPath(path);
        try {
            if (existing instanceof TFile) {
                new Notice(`📦 Collection note already exists: ${path}`);
            } else {
                await vault.create(path, COLLECTION_TEMPLATE);
                new Notice(`✅ Collection note created: ${path}`);
            }
            const file = vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                await this.app.workspace.getLeaf(false).openFile(file);
            }
        } catch (err) {
            new Notice(`❌ Failed to create collection note: ${err.message}`);
        }
    }

    // Opens the collection note in the editor for direct manual editing —
    // e.g. bulk-pasting a list, fixing a typo, or reordering — rather than
    // going through the Collection Manager's click-to-add/remove UI one
    // card at a time. Unlike createCollectionNote(), this never creates the
    // file; it just tells you to if it's missing.
    async openCollectionNote() {
        const file = this.getCollectionFile();
        if (!file) {
            new Notice(`⚠️ No collection note at "${this.settings.collectionNotePath}" yet. Use "📦 Create Collection Note" first.`);
            return;
        }
        await this.app.workspace.getLeaf(false).openFile(file);
    }

    async createDeckTemplate() {
        const vault = this.app.vault;
        const templateFileName = 'Master Duel Deck Template.md';

        // ── 1. Resolve Templates folder ──────────────────────────────────────
        // Prefer Obsidian's own "Templates" core-plugin folder setting if set,
        // then the community "Templater" plugin setting, then fall back to a
        // folder literally named "Templates" at the vault root.
        let folderPath = 'Templates'; // sensible default

        try {
            const coreTemplates = this.app.internalPlugins?.plugins?.['templates']?.instance?.options?.folder;
            if (coreTemplates) folderPath = coreTemplates;
        } catch (_) { }

        try {
            const templaterSettings = this.app.plugins?.plugins?.['templater-obsidian']?.settings?.templates_folder;
            if (templaterSettings) folderPath = templaterSettings;
        } catch (_) { }

        // Strip any trailing slash for consistency
        folderPath = folderPath.replace(/\/+$/, '');

        // ── 2. Ensure the folder exists ──────────────────────────────────────
        const existingFolder = vault.getAbstractFileByPath(folderPath);
        if (!existingFolder) {
            try {
                await vault.createFolder(folderPath);
                new Notice(`📁 Created folder: ${folderPath}`);
            } catch (err) {
                new Notice(`❌ Could not create folder "${folderPath}": ${err.message}`);
                return;
            }
        }

        // ── 3. Write the template file ───────────────────────────────────────
        const filePath = `${folderPath}/${templateFileName}`;
        const existing = vault.getAbstractFileByPath(filePath);

        try {
            if (existing instanceof TFile) {
                // Overwrite with fresh content
                await vault.modify(existing, DECK_TEMPLATE);
                new Notice(`✅ Template updated: ${filePath}`);
            } else {
                await vault.create(filePath, DECK_TEMPLATE);
                new Notice(`✅ Template created: ${filePath}`);
            }
            // Open the new file so the user sees it immediately
            const file = vault.getAbstractFileByPath(filePath);
            if (file instanceof TFile) {
                await this.app.workspace.getLeaf(false).openFile(file);
            }
        } catch (err) {
            new Notice(`❌ Failed to write template: ${err.message}`);
        }
    }

    async fetchCard(name) {
        // Some templates use short names — map them to the exact API name
        const ALIASES = {
            'Ash Blossom': 'Ash Blossom & Joyous Spring',
            'Linkuriboh': 'Linkuriboh',
            // "Strahl" is Dragonmaid Sheou's Japanese name, not a substring of its
            // English name — fuzzy search can never find it, only an alias can.
            'Strahl': 'Dragonmaid Sheou',
        };
        const normalisedName = name.replace(/–/g, '-').replace(/—/g, '-');
        const resolvedName = ALIASES[normalisedName] || normalisedName;
        try {
            const res = await fetch(
                `https://db.ygoprodeck.com/api/v7/cardinfo.php?name=${encodeURIComponent(resolvedName)}&misc=yes`
            );
            if (!res.ok) return null;
            const data = await res.json();
            if (!data.data || data.data.length === 0) return null;
            const c = data.data[0];
            return {
                name: c.name, type: c.type, atk: c.atk, def: c.def,
                desc: c.desc, image: c.card_images[0].image_url,
                archetype: c.archetype,
                ban_tcg: c.banlist_info?.ban_tcg || 'Unlimited',
                konami_id: c.misc_info?.[0]?.konami_id,
                ban_md: this.getBanStatusMD(c.misc_info?.[0]?.konami_id),
                rarity: this.rarityDB[c.name] || this.normalizeMdRarity(c.misc_info?.[0]?.md_rarity) || this.getRarity(c),
                frameType: c.frameType
            };
        } catch (err) {
            console.error('[YugiohPlugin] fetchCard error:', err);
            return null;
        }
    }

    // API misc_info.md_rarity comes back as a full word ("Ultra Rare") rather
    // than the UR/SR/R/N abbreviation the rest of the plugin uses — normalize
    // it, or return null (not 'N') when absent so callers can fall through to
    // the type-based heuristic instead of wrongly treating "no data" as Normal.
    normalizeMdRarity(raw) {
        if (!raw) return null;
        if (/^[A-Z]{1,3}$/.test(raw)) return raw; // already abbreviated
        const map = {
            'ultra rare': 'UR', 'super rare': 'SR', 'rare': 'R',
            'normal': 'N', 'common': 'N'
        };
        return map[raw.toLowerCase()] || null;
    }

    // Combo steps often use shorthand/nicknames ("Chamber", "Sheou", "Tidying (GY)")
    // instead of a card's exact printed name, so an exact-match lookup misses them.
    // This does a fuzzy search and returns every plausible match (whole-word only,
    // so "Chamber" doesn't also match "Ancient Chamber Excavated" etc.) so the
    // caller can pick the best one using deck context.
    async fetchCardCandidates(name, _retried = false) {
        const cleaned = name
            .replace(/\s*\([^)]*\)\s*$/, '') // drop trailing notes like "(GY)"
            .replace(/–/g, '-').replace(/—/g, '-')
            .trim();
        if (cleaned.length < 3) return [];
        try {
            const res = await fetch(
                `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(cleaned)}&misc=yes`
            );
            if (!res.ok) {
                // 429 (rate limited) is common when many fuzzy lookups fire in quick
                // succession — back off briefly and retry once before giving up.
                if (res.status === 429 && !_retried) {
                    await new Promise(r => setTimeout(r, 600));
                    return this.fetchCardCandidates(name, true);
                }
                return [];
            }
            const data = await res.json();
            if (!data.data || data.data.length === 0) return [];
            const wordRe = new RegExp(`\\b${cleaned.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            return data.data
                .filter(c => wordRe.test(c.name))
                .slice(0, 10)
                .map(c => ({
                    name: c.name, type: c.type, atk: c.atk, def: c.def,
                    desc: c.desc, image: c.card_images[0].image_url,
                    archetype: c.archetype,
                    ban_tcg: c.banlist_info?.ban_tcg || 'Unlimited',
                    konami_id: c.misc_info?.[0]?.konami_id,
                    ban_md: this.getBanStatusMD(c.misc_info?.[0]?.konami_id),
                    rarity: this.rarityDB[c.name] || this.normalizeMdRarity(c.misc_info?.[0]?.md_rarity) || this.getRarity(c),
                    frameType: c.frameType
                }));
        } catch (err) {
            // Network hiccup — one quiet retry before giving up.
            if (!_retried) {
                await new Promise(r => setTimeout(r, 500));
                return this.fetchCardCandidates(name, true);
            }
            console.error('[YugiohPlugin] fetchCardCandidates error:', err);
            return [];
        }
    }

    // Advanced Search — combines whichever filters the user filled in
    // (name is fuzzy via YGOPRODeck's `fname`, everything else maps to its
    // own query param) into one API call, then applies the Master Duel
    // rarity filter client-side since rarity isn't something the API knows
    // about (it's resolved the same way fetchCard/fetchCardCandidates do).
    async searchCards(filters, _retried = false) {
        const params = new URLSearchParams();
        if (filters.name) params.set('fname', filters.name.trim());
        if (filters.type) params.set('type', filters.type);
        if (filters.attribute) params.set('attribute', filters.attribute);
        if (filters.level) params.set('level', String(filters.level));
        if (filters.archetype) params.set('archetype', filters.archetype.trim());
        params.set('misc', 'yes');

        // Alt art cards are sparse and scattered across the ~30k-card database
        // (not clustered alphabetically), so the normal 40-card page essentially
        // never contains one unless a name/type/archetype filter has already
        // narrowed things down hard. When "alt art only" is checked, widen the
        // page size a lot so the filter actually has something to find instead
        // of silently checking an arbitrary slice.
        const numLimit = filters.altArtOnly ? 99999 : 40;
        params.set('num', String(numLimit));
        params.set('offset', '0');

        const realFilterKeys = ['fname', 'type', 'attribute', 'level', 'archetype'];
        const hasRealFilter = realFilterKeys.some(k => params.has(k)) || filters.rarity || filters.altArtOnly;
        if (!hasRealFilter) {
            return { error: 'Enter at least one filter (name, type, attribute, level, archetype, rarity, or alt art only).' };
        }

        try {
            const res = await fetch(`https://db.ygoprodeck.com/api/v7/cardinfo.php?${params.toString()}`);
            if (!res.ok) {
                if (res.status === 429 && !_retried) {
                    await new Promise(r => setTimeout(r, 600));
                    return this.searchCards(filters, true);
                }
                if (res.status === 400) return { results: [] }; // API's "no match" response
                return { error: `Search failed (HTTP ${res.status}).` };
            }
            const data = await res.json();
            if (!data.data || data.data.length === 0) return { results: [] };
            const baseCount = data.data.length;

            // card_images holds every art variant for this card (index 0 is
            // the default/original art, any further entries are alt arts) —
            // expand each into its own result tile instead of only ever
            // taking [0], or alt arts never appear at all.
            let results = [];
            for (const c of data.data) {
                const base = {
                    name: c.name, type: c.type, atk: c.atk, def: c.def,
                    level: c.level ?? c.linkval, attribute: c.attribute, race: c.race,
                    desc: c.desc, archetype: c.archetype,
                    ban_tcg: c.banlist_info?.ban_tcg || 'Unlimited',
                    konami_id: c.misc_info?.[0]?.konami_id,
                    ban_md: this.getBanStatusMD(c.misc_info?.[0]?.konami_id),
                    rarity: this.rarityDB[c.name] || this.normalizeMdRarity(c.misc_info?.[0]?.md_rarity) || this.getRarity(c),
                    frameType: c.frameType
                };
                const images = c.card_images && c.card_images.length ? c.card_images : [];
                images.forEach((img, idx) => {
                    results.push({
                        ...base,
                        image: img.image_url,
                        artId: img.id,
                        artVariant: idx > 0 ? (images.length > 2 ? `Alt Art ${idx}` : 'Alt Art') : null,
                    });
                });
            }

            if (filters.rarity) {
                results = results.filter(c => c.rarity === filters.rarity);
            }
            if (filters.altArtOnly) {
                results = results.filter(c => c.artVariant);
            }

            const totalMatches = results.length;
            const DISPLAY_CAP = 60;
            if (results.length > DISPLAY_CAP) results = results.slice(0, DISPLAY_CAP);

            return {
                results,
                totalMatches,
                capped: filters.altArtOnly ? totalMatches > DISPLAY_CAP : baseCount >= numLimit,
            };
        } catch (err) {
            console.error('[YugiohPlugin] searchCards error:', err);
            return { error: 'Network error while searching.' };
        }
    }

    getRarity(card) {
        if (card.type.includes('Fusion') || card.type.includes('Link')) return 'UR';
        if (card.type.includes('Effect')) return 'SR';
        if (card.type.includes('Spell') || card.type.includes('Trap')) return 'R';
        return 'N';
    }
}

// ─── Rarity styling ──────────────────────────────────────────────────────────
const RARITY_COLOR = { UR: '#e8c84a', SR: '#c084f5', R: '#60a5fa', N: '#94a3b8' };
const RARITY_LABEL = { UR: '◆ UR', SR: '◇ SR', R: '● R', N: '○ N' };

// ─── Deck Analysis: heuristic card-role classification ──────────────────────
// No manual tagging — a card's role is inferred purely from its type + effect
// text via keyword heuristics. This is a rough approximation of real deck-
// building theory, not a rules engine, and is shown as such in the UI:
//   Starter  — usable from an empty board/hand alone; gets the combo going
//              (self-summons, searches a card, draws cards).
//   Extender — picks up where a starter left off by recurring or re-using a
//              resource (GY effects, on-destruction triggers, GY revival).
//   Brick    — dead or low-value alone (vanilla monsters, equip spells that
//              need a monster already down).
//   Other    — doesn't clearly match any of the above (hand traps, generic
//              removal, staples) — shown separately rather than forced in.
// NOTE: every pattern below is matched with plain (non-multiline) regexes
// against a single lowercased desc string, never split into per-line
// sections — an earlier feature attempt broke by using `$` with the `m` flag
// on a multi-line capture, which matches end-of-LINE instead of end-of-
// string and silently truncates after the first line. Nothing here spans
// lines, so that failure mode doesn't apply.
const ROLE_META = {
    starter: { label: '🟢 Starter', color: '#4ade80' },
    extender: { label: '🔵 Extender', color: '#60a5fa' },
    handtrap: { label: '🪤 Hand Trap', color: '#f87171' },
    brick: { label: '🟤 Brick', color: '#a8a29e' },
    other: { label: '⚪ Other', color: '#94a3b8' },
};

function classifyCardRole(card) {
    const type = card.type || '';
    const desc = (card.desc || '').toLowerCase();
    const isMonster = type.includes('Monster');
    const isExtraDeck = /Fusion|Synchro|XYZ|Xyz|Link/.test(type);

    // Extra Deck monsters are never drawn into an opening hand — the
    // starter/extender/brick concept (which is about hand quality) doesn't
    // apply to them.
    if (isExtraDeck) {
        return { role: 'other', reason: 'Extra Deck monster — not part of opening-hand odds.' };
    }

    // Known hand traps and hand-trap-style staple disruption (see HAND_TRAPS
    // comment) — its own bucket, distinct from "Other", since it's a
    // well-defined disruption role rather than a catch-all.
    if (HAND_TRAPS.includes(card.name)) {
        return { role: 'handtrap', reason: 'Disruption/negation staple — not a combo piece.' };
    }

    // ── Brick checks ────────────────────────────────────────────────────────
    if (isMonster && type.includes('Normal') && !type.includes('Effect')) {
        return { role: 'brick', reason: 'Vanilla Normal Monster — no effect, dead card alone.' };
    }
    if (type.includes('Equip Spell') && !desc.includes('add') && !desc.includes('special summon')) {
        return { role: 'brick', reason: 'Equip Spell — needs a monster already on board to do anything.' };
    }

    // ── Starter checks ──────────────────────────────────────────────────────
    const starterPatterns = [
        /special summon this card \(from your hand\)/,
        /you can special summon this card from your hand/,
        /can be special summoned.*from your hand/,
        /add 1 .*from your deck to your hand/,
        /add .*from your deck or gy to your hand/,
        /draw 2 cards/,
        /you can only activate this card if you control no other cards/,
        /if you control no other cards, you can/,
        /special summon 1 .*from your hand/,
    ];
    if (starterPatterns.some(re => re.test(desc))) {
        return { role: 'starter', reason: 'Searches, draws, or self-summons — usable from an empty board.' };
    }

    // ── Extender checks ──────────────────────────────────────────────────────
    // NOTE: real card text (and ygoprodeck's desc field) abbreviates Graveyard
    // as "GY", not spelled out — e.g. Dragonmaid Tidying reads "You can banish
    // this card from your GY; Special Summon...". Every pattern below matches
    // "gy" (with "graveyard" also tolerated defensively, since some
    // third-party sources spell it out) — an earlier version of this file
    // only matched "graveyard", which meant these patterns effectively never
    // fired against real card text and everything GY-reliant fell into
    // "Other" instead of "Extender".
    const GY = '(?:gy|graveyard)';
    const extenderPatterns = [
        new RegExp(`special summon this card from your (?:hand or )?${GY}`),
        new RegExp(`you can banish this card from your ${GY}`),
        new RegExp(`if this card is (?:sent to the ${GY}|destroyed)`),
        new RegExp(`when this card is (?:sent to the ${GY}|destroyed)`),
        new RegExp(`shuffle this card into the deck.*special summon`),
        new RegExp(`special summon 1 .*from your ${GY}`),
        // Self-recursion from the GY back to hand (e.g. Dragonmaid Changeover:
        // "While this card is in your GY: ... add this card to your hand").
        new RegExp(`add this card to your hand`),
        // Generic revival spells/traps phrased as "target 1 monster in
        // (either|your) GY; Special Summon it" (e.g. Monster Reborn) rather
        // than "Special Summon ... from your GY".
        new RegExp(`target 1 monster in (?:either|your) ${GY}.*special summon`),
    ];
    if (extenderPatterns.some(re => re.test(desc))) {
        return { role: 'extender', reason: 'Recurs or extends from the Graveyard — picks up after a starter.' };
    }

    return { role: 'other', reason: "Doesn't clearly match Starter/Extender/Brick patterns — generic effect." };
}

class DeckUI extends Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.decks = { main60: [], main40: [], extra: [] };
        this.allCards = [];
        this.combos = [];
        this.comboCardCache = new Map(); // name.toLowerCase() → card object
        this.collectionMap = new Map(); // name.toLowerCase() → { count, rarity } from the collection note
        this.activeTab = 'main60';
        this.analysisDeck = null; // resolved lazily on first visit to the Analysis tab
        this.loading = false;
    }

    async onOpen() {
        // Widen the modal
        this.modalEl.style.width = '900px';
        this.modalEl.style.maxWidth = '95vw';
        this.modalEl.style.maxHeight = '92vh';

        const { contentEl } = this;
        contentEl.style.cssText = `
            background: #0d0f1a; color: #e2e8f0;
            font-family: 'Georgia', serif;
            padding: 0; overflow: hidden;
            display: flex; flex-direction: column; height: 82vh;
        `;

        // ── Header ──────────────────────────────────────────────────────────
        const header = contentEl.createEl('div');
        header.style.cssText = `
            background: linear-gradient(135deg, #1a0a2e 0%, #16213e 50%, #0f3460 100%);
            padding: 16px 24px 12px;
            border-bottom: 2px solid #e8c84a44;
            flex-shrink: 0;
        `;
        const title = header.createEl('h1');
        title.textContent = '🐉 Deck Builder';
        title.style.cssText = `
            margin: 0 0 3px; font-size: 1.35em; font-weight: bold;
            background: linear-gradient(90deg, #e8c84a, #f5c3ff);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent;
            background-clip: text;
        `;
        const sub = header.createEl('p');
        sub.style.cssText = 'margin: 0; font-size: 0.72em; color: #94a3b8; font-family: monospace;';
        const activeFile = this.plugin.getActiveFile();
        sub.textContent = activeFile
            ? `📄 ${activeFile.path}  •  Click a card to toggle owned ✅`
            : `⚠️ No note open — open your checklist note first!`;

        // ── Toolbar ─────────────────────────────────────────────────────────
        const searchRow = contentEl.createEl('div');
        searchRow.style.cssText = `
            display: flex; gap: 8px; padding: 10px 20px;
            background: #111827; border-bottom: 1px solid #1f2937;
            flex-shrink: 0; align-items: center; flex-wrap: wrap;
        `;

        const input = searchRow.createEl('input');
        input.placeholder = 'Add card by exact name (e.g. Pot of Greed)…';
        input.style.cssText = `
            flex: 1; min-width: 160px; background: #1f2937; border: 1px solid #374151;
            border-radius: 6px; padding: 7px 12px; color: #e2e8f0;
            font-size: 0.88em; outline: none; font-family: monospace;
        `;
        input.addEventListener('focus', () => input.style.borderColor = '#e8c84a');
        input.addEventListener('blur', () => input.style.borderColor = '#374151');

        const addBtn = this.makeBtn(searchRow, '＋ Add', '#e8c84a', '#0d0f1a');
        const loadBtn = this.makeBtn(searchRow, '🔄 Reload', '#c084f5', '#fff');
        const statsBtn = this.makeBtn(searchRow, '📊 Stats', '#60a5fa', '#fff');
        const validateBtn = this.makeBtn(searchRow, '✅ Validate', '#4ade80', '#0d0f1a');
        const craftBtn = this.makeBtn(searchRow, '📦 Craft List', '#f472b6', '#fff');
        craftBtn.title = 'What you still need to craft, based on your Collection note';
        const applyTplBtn = this.makeBtn(searchRow, '🗋 Apply Template', '#1f2937', '#f87171');
        applyTplBtn.title = 'Overwrite the current note with the blank deck template';

        // ── Tab bar ─────────────────────────────────────────────────────────
        const tabBar = contentEl.createEl('div');
        tabBar.classList.add('yugioh-tabbar-scroll');
        tabBar.style.cssText = `
            display: flex; gap: 0; flex-shrink: 0; overflow-x: auto; overflow-y: hidden;
            background: #0d0f1a; border-bottom: 2px solid #1f2937;
        `;
        // Thin, theme-matching scrollbar for the tab bar (Chromium/Electron —
        // Obsidian's renderer) so overflowing tabs (e.g. Analysis on a narrow
        // window) are reachable by scroll instead of just clipped off-screen.
        const tabBarScrollStyle = contentEl.createEl('style');
        tabBarScrollStyle.textContent = `
            .yugioh-tabbar-scroll::-webkit-scrollbar { height: 5px; }
            .yugioh-tabbar-scroll::-webkit-scrollbar-thumb { background: #374151; border-radius: 3px; }
            .yugioh-tabbar-scroll::-webkit-scrollbar-track { background: transparent; }
        `;

        const TABS = [
            { key: 'main60', label: '🟦 Main Deck (60)', color: '#60a5fa' },
            { key: 'main40', label: '🟢 40-Card Variant', color: '#4ade80' },
            { key: 'extra', label: '🟥 Extra Deck', color: '#f87171' },
            { key: 'combos', label: '🧠 Combos', color: '#a78bfa' },
            { key: 'hand', label: '🎲 Test Hand', color: '#e8c84a' },
            { key: 'analysis', label: '📈 Analysis', color: '#f472b6' },
        ];
        this.tabEls = {};
        for (const tab of TABS) {
            const btn = tabBar.createEl('button');
            btn.textContent = tab.label;
            btn.dataset.tabKey = tab.key;
            btn.style.cssText = `
                background: none; border: none; border-bottom: 3px solid transparent;
                padding: 9px 14px; color: #6b7280; cursor: pointer; flex: 0 0 auto;
                font-size: 0.8em; font-weight: bold; font-family: monospace;
                transition: color .15s, border-color .15s; white-space: nowrap;
            `;
            btn.onmouseenter = () => { if (this.activeTab !== tab.key) btn.style.color = '#e2e8f0'; };
            btn.onmouseleave = () => { if (this.activeTab !== tab.key) btn.style.color = '#6b7280'; };
            btn.onclick = () => this.switchTab(tab.key);
            this.tabEls[tab.key] = { btn, color: tab.color };
        }

        // ── Status bar ──────────────────────────────────────────────────────
        const statusBar = contentEl.createEl('div');
        statusBar.style.cssText = `
            padding: 3px 22px; font-size: 0.7em; color: #6b7280;
            background: #0d0f1a; flex-shrink: 0; font-family: monospace;
            border-bottom: 1px solid #1f2937;
        `;
        this.statusBar = statusBar;
        this.setStatus('Loading template…');

        // ── Card grid ───────────────────────────────────────────────────────
        const grid = contentEl.createEl('div');
        grid.style.cssText = `
            flex: 1; overflow-y: auto; padding: 16px 20px;
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(108px, 1fr));
            gap: 10px; align-content: start;
        `;
        this.grid = grid;

        // ── Event handlers ───────────────────────────────────────────────────
        input.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });

        addBtn.onclick = async () => {
            const name = input.value.trim();
            if (!name) return new Notice('Enter a card name.');
            if (this.loading) return;

            this.loading = true; addBtn.disabled = true;
            this.setStatus(`Fetching "${name}"…`);
            const fetched = await this.plugin.fetchCard(name);
            this.loading = false; addBtn.disabled = false;

            if (!fetched) {
                this.setStatus(`❌ Not found: "${name}"`);
                return new Notice(`Card not found: "${name}"`);
            }

            const added = await this.addFetchedCardToDeck(fetched);
            if (added) input.value = '';
        };

        const searchBtn = this.makeBtn(searchRow, '🔎 Search', '#8b5cf6', '#fff');
        searchBtn.title = 'Advanced search — type, attribute, level, archetype, rarity';
        searchBtn.onclick = () => new CardSearchUI(this.app, this.plugin, this).open();

        loadBtn.onclick = async () => {
            this.collectionMap = await this.plugin.loadCollectionMap();
            await this.loadFromTemplate();
        };
        statsBtn.onclick = () => this.showStats();
        validateBtn.onclick = () => this.showValidation();
        craftBtn.onclick = () => this.showCraftList();
        applyTplBtn.onclick = () => this.confirmApplyTemplate();

        // Auto-load on open
        this.collectionMap = await this.plugin.loadCollectionMap();
        await this.loadFromTemplate();
    }

    makeBtn(parent, label, bg, color) {
        const btn = parent.createEl('button');
        btn.textContent = label;
        btn.style.cssText = `
            background: ${bg}; color: ${color}; border: none;
            padding: 7px 13px; border-radius: 6px; cursor: pointer;
            font-weight: bold; font-size: 0.8em; white-space: nowrap;
            transition: opacity .15s;
        `;
        btn.onmouseenter = () => btn.style.opacity = '0.75';
        btn.onmouseleave = () => btn.style.opacity = '1';
        return btn;
    }

    // Shared by the exact-name "＋ Add" flow and CardSearchUI's result tiles —
    // both end up with an already-fetched card object and just need it
    // stacked into the active deck tab and saved. Returns false (with a
    // Notice) if the active tab isn't a real deck group, so callers can tell
    // whether the add actually happened.
    async addFetchedCardToDeck(fetched) {
        const group = this.activeTab;
        if (!this.decks[group]) {
            new Notice(`Switch to Main Deck, 40-Card Variant, or Extra Deck to add cards (not "${group}").`);
            return false;
        }

        const existing = this.decks[group].find(c => c.name.toLowerCase() === fetched.name.toLowerCase());
        let entry;
        if (existing) {
            existing.count = (existing.count || 1) + 1;
            existing.owned = true;
            entry = existing;
        } else {
            const copy = { ...fetched, owned: true, count: 1, deckGroup: group };
            this.decks[group].push(copy);
            this.allCards.push(copy);
            entry = copy;
        }

        this.switchTab(group); // re-render from this.decks so counts/tiles stay in sync
        this.setStatus(`✅ "${entry.name}" [${entry.rarity}] ×${entry.count} in ${group} — saving…`);
        await this.saveCardToTemplate(entry);
        return true;
    }

    // Extract every word/phrase from combo texts that could be a card name,
    // fetch the ones not already known, and populate comboCardCache.
    async prefetchComboCards() {
        // Seed cache from already-loaded deck cards
        for (const c of this.allCards) {
            this.comboCardCache.set(c.name.toLowerCase(), c);
        }

        // Collect all unique tokens (split on →, ->, ➜, and common noise words)
        const tokenSet = new Set();
        const stepSet = new Set(); // full step phrases, e.g. "Chamber", "Tidying (GY)"
        for (const combo of (this.combos || [])) {
            // Split on arrows to get individual step phrases
            const parts = combo.text.split(/→|->|➜/).map(s => s.trim()).filter(Boolean);
            // Generic action/connector words that are never a card name on their own —
            // skip fuzzy-searching these to cut down noisy, useless API calls, and strip
            // them off the edges of a whole step phrase before fuzzy-searching that
            // phrase verbatim (see stripStopwordEdges below).
            const STOPWORDS = new Set([
                'mill', 'draw', 'dump', 'loop', 'setup', 'route', 'line', 'board',
                'break', 'up', 'negate', 'summon', 'timing', 'pop', 'extender',
                'the', 'and', 'of', 'in', 'to', 'for', 'on', 'at', 'as', 'or',
                'set', 'activate', 'discard', 'banish', 'tribute', 'flip', 'target',
                'return', 'add', 'send', 'shuffle', 'reveal', 'destroy', 'special', 'normal',
            ]);
            // A step like "Set Tidying" fuzzy-searched verbatim can match some
            // unrelated card whose name happens to score closer to the whole
            // phrase than the real target does (e.g. "Set Tidying" → "Aquarium
            // Set" instead of "Dragonmaid Tidying") — and because that wrong
            // match gets cached under the exact key "set tidying", it then
            // shadows the correct per-word fallback at render time. Strip
            // leading/trailing action verbs before a phrase is used as a
            // whole-phrase fuzzy-search candidate; the per-word windows below
            // still cover the untouched original text.
            const stripStopwordEdges = (phrase) => {
                let w = phrase.split(/\s+/);
                while (w.length > 1 && STOPWORDS.has(w[0].toLowerCase())) w = w.slice(1);
                while (w.length > 1 && STOPWORDS.has(w[w.length - 1].toLowerCase())) w = w.slice(0, -1);
                return w.join(' ');
            };
            for (const part of parts) {
                stepSet.add(stripStopwordEdges(part));
                // A card name can sit anywhere in a phrase, with notes before or after
                // it ("mill Tidying + Changeover setup", "Accesscode OTK route") — add
                // every contiguous word-window so the card name surfaces on its own,
                // however it's positioned.
                const addWindows = (phrase) => {
                    const w = phrase.split(/\s+/);
                    for (let len = w.length; len >= 1; len--) {
                        for (let start = 0; start <= w.length - len; start++) {
                            const candidate = w.slice(start, start + len).join(' ').trim();
                            if (candidate.length < 3) continue;
                            if (len === 1 && STOPWORDS.has(candidate.toLowerCase())) continue;
                            stepSet.add(candidate);
                        }
                    }
                };
                addWindows(part);
                // Compound steps can name multiple cards in one segment, e.g.
                // "Wyverburster / Collapserpent loop" or "Bystial + Maid" — add
                // each sub-phrase (and its word-windows) so each card can resolve
                // on its own even though the segment as a whole isn't a card name.
                const subParts = part.split(/[/+]/).map(s => s.trim()).filter(Boolean);
                if (subParts.length > 1) {
                    for (const sub of subParts) {
                        const coreSub = stripStopwordEdges(sub);
                        if (coreSub.length >= 3) stepSet.add(coreSub);
                        addWindows(sub);
                    }
                }
                // Each part might be a card name or partial phrase — try the whole phrase
                // and also sliding windows of 1–4 words to catch multi-word card names
                const words = part.split(/\s+/);
                for (let len = words.length; len >= 1; len--) {
                    for (let start = 0; start <= words.length - len; start++) {
                        const candidate = words.slice(start, start + len).join(' ').trim();
                        if (candidate.length >= 3) tokenSet.add(candidate);
                    }
                }
            }
        }

        // Pass 1: exact-name lookup for every candidate substring (used for
        // highlighting a full card name if it appears verbatim inside combo text).
        const toFetch = [...tokenSet].filter(t => !this.comboCardCache.has(t.toLowerCase()));
        const BATCH = 6;
        for (let i = 0; i < toFetch.length; i += BATCH) {
            const batch = toFetch.slice(i, i + BATCH);
            const results = await Promise.all(batch.map(name => this.plugin.fetchCard(name)));
            for (let j = 0; j < batch.length; j++) {
                if (results[j]) {
                    this.comboCardCache.set(batch[j].toLowerCase(), results[j]);
                    // Also add canonical name key in case casing differs
                    this.comboCardCache.set(results[j].name.toLowerCase(), results[j]);
                }
            }
        }

        // Pass 2: any full step still unresolved is likely a shorthand/nickname
        // ("Chamber", "Sheou", "Tidying (GY)") rather than a card's exact printed
        // name — fuzzy-resolve those so the step-by-step view can show full card art.
        const knownArchetypes = new Set(this.allCards.map(c => c.archetype).filter(Boolean));
        const stepsToFuzzy = [...stepSet].filter(s => !this.comboCardCache.has(s.toLowerCase()));
        const FUZZY_BATCH = 3;
        for (let i = 0; i < stepsToFuzzy.length; i += FUZZY_BATCH) {
            const batch = stepsToFuzzy.slice(i, i + FUZZY_BATCH);
            const results = await Promise.all(batch.map(name => this.plugin.fetchCardCandidates(name)));
            for (let j = 0; j < batch.length; j++) {
                const candidates = results[j];
                if (!candidates.length) continue;
                // Prefer a match sharing an archetype with the current deck (e.g.
                // "Chamber" → "Dragonmaid Chamber" over an unrelated card), else
                // fall back to the shortest name — closest to the shorthand used.
                const best = candidates.find(c => knownArchetypes.has(c.archetype))
                    || candidates.reduce((a, b) => (a.name.length <= b.name.length ? a : b));
                this.comboCardCache.set(batch[j].toLowerCase(), best);
                this.comboCardCache.set(best.name.toLowerCase(), best);
            }
            if (i + FUZZY_BATCH < stepsToFuzzy.length) {
                await new Promise(r => setTimeout(r, 200));
            }
        }
    }

    switchTab(key) {
        this.activeTab = key;
        const LABELS = {
            main60: '🟦 Main Deck (60)',
            main40: '🟢 40-Card Variant',
            extra: '🟥 Extra Deck',
            combos: '🧠 Combos',
            hand: '🎲 Test Hand',
            analysis: '📈 Analysis',
        };
        // Update tab button styles
        for (const [k, { btn, color }] of Object.entries(this.tabEls)) {
            const active = k === key;
            if (k === 'combos') {
                const count = (this.combos || []).length;
                btn.textContent = count > 0 ? `${LABELS[k]} · ${count}` : LABELS[k];
            } else {
                const count = (this.decks[k] || []).length;
                btn.textContent = count > 0 ? `${LABELS[k]} · ${count}` : LABELS[k];
            }
            btn.style.color = active ? color : '#6b7280';
            btn.style.borderBottom = active ? `3px solid ${color}` : '3px solid transparent';
            btn.style.background = active ? color + '18' : 'none';
        }
        // Re-render content area
        this.grid.empty();
        if (key === 'combos') {
            this.grid.style.display = 'block';
            // Show a loading state, pre-fetch any card names found in combo text, then render
            const loadingEl = this.grid.createEl('div');
            loadingEl.style.cssText = 'color:#6b7280;font-family:monospace;font-size:0.82em;padding:20px;text-align:center;';
            loadingEl.textContent = '🔍 Resolving card names in combos…';
            this.prefetchComboCards().then(() => {
                this.grid.empty();
                this.renderCombos(this.grid);
            });
        } else if (key === 'hand') {
            this.grid.style.display = 'block';
            this.renderHandSimulator(this.grid);
        } else if (key === 'analysis') {
            this.grid.style.display = 'block';
            this.renderAnalysis(this.grid);
        } else {
            this.grid.style.display = 'grid';
            const cards = this.decks[key] || [];
            if (cards.length === 0) {
                const empty = this.grid.createEl('div');
                empty.style.cssText = `
                    color: #4b5563; font-family: monospace; font-size: 0.85em;
                    grid-column: 1 / -1; padding: 30px 0; text-align: center;
                `;
                empty.textContent = `No cards found for this deck view.`;
            } else {
                for (const card of cards) this.renderCard(card, this.grid);
            }
        }
    }

    // ── Opening Hand Simulator ──────────────────────────────────────────────
    // Draws from the 40-card variant if it has cards (an exact, fixed pool),
    // otherwise the 40–60 Main Deck. Extra Deck is never drawn from.
    buildDrawPool() {
        const hasVariant = this.decks.main40.length > 0;
        const mainCards = hasVariant ? this.decks.main40 : this.decks.main60;
        const pool = [];
        for (const c of mainCards) {
            const copies = c.count || 1;
            for (let i = 0; i < copies; i++) pool.push(c);
        }
        return pool;
    }

    shuffleSample(arr, n) {
        const copy = arr.slice();
        for (let i = copy.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [copy[i], copy[j]] = [copy[j], copy[i]];
        }
        return copy.slice(0, Math.min(n, copy.length));
    }

    renderHandSimulator(container) {
        const pool = this.buildDrawPool();
        const usingVariant = this.decks.main40.length > 0;

        const controls = container.createEl('div');
        controls.style.cssText = `
            display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; align-items: center;
        `;

        const info = controls.createEl('span');
        info.style.cssText = 'font-size: 0.75em; color: #6b7280; font-family: monospace; margin-right: auto;';
        info.textContent = pool.length > 0
            ? `Pool: ${pool.length} cards (${usingVariant ? '40-Card Variant' : 'Main Deck'})`
            : 'No main deck cards loaded — load a deck first.';

        const draw5Btn = this.makeBtn(controls, '🎲 Draw 5 · Going First', '#e8c84a', '#0d0f1a');
        const draw6Btn = this.makeBtn(controls, '🎲 Draw 6 · Going Second', '#c084f5', '#fff');
        const redrawBtn = this.makeBtn(controls, '🔄 Redraw', '#60a5fa', '#fff');
        const consistency5Btn = this.makeBtn(controls, '📊 10k Hands (5)', '#4ade80', '#0d0f1a');
        const consistency6Btn = this.makeBtn(controls, '📊 10k Hands (6)', '#4ade80', '#0d0f1a');

        const handWrap = container.createEl('div');
        handWrap.style.cssText = 'display: flex; gap: 10px; flex-wrap: wrap; padding: 6px 0;';

        const renderHand = () => {
            handWrap.empty();
            if (!this.currentHand || this.currentHand.length === 0) {
                const empty = handWrap.createEl('div');
                empty.style.cssText = `
                    color: #4b5563; font-family: monospace; font-size: 0.85em;
                    padding: 30px 0; width: 100%; text-align: center;
                `;
                empty.textContent = 'Draw a hand to see it here.';
                return;
            }
            for (const card of this.currentHand) this.renderHandCard(card, handWrap);
            const trapCount = this.currentHand.filter(c => HAND_TRAPS.includes(c.name)).length;
            if (trapCount > 0) {
                const note = handWrap.createEl('div');
                note.style.cssText = 'width: 100%; font-size: 0.72em; color: #facc15; font-family: monospace; margin-top: 4px;';
                note.textContent = `🪤 ${trapCount} hand trap${trapCount > 1 ? 's' : ''} in this hand`;
            }
        };

        const doDraw = n => {
            if (pool.length === 0) { new Notice('No main deck cards to draw from — load a deck first.'); return; }
            this.lastHandSize = n;
            this.currentHand = this.shuffleSample(pool, n);
            renderHand();
        };

        draw5Btn.onclick = () => doDraw(5);
        draw6Btn.onclick = () => doDraw(6);
        redrawBtn.onclick = () => doDraw(this.lastHandSize || 5);

        // ── Consistency Test — thousands of simulated opening hands ──────────
        const resultsWrap = container.createEl('div');
        resultsWrap.style.cssText = 'margin-top: 18px; padding-top: 14px; border-top: 1px solid #1f2937; display: none;';

        const runConsistency = (handSize) => {
            if (pool.length === 0) { new Notice('No main deck cards to draw from — load a deck first.'); return; }
            const btn = handSize === 5 ? consistency5Btn : consistency6Btn;
            const originalLabel = btn.textContent;
            btn.disabled = true;
            btn.textContent = '⏳ Running…';
            // Defer one tick so the "Running…" label actually paints before the
            // (synchronous) simulation loop blocks the thread.
            setTimeout(() => {
                const stats = this.runConsistencyTest(pool, handSize, 10000);
                this.renderConsistencyResults(resultsWrap, stats, handSize);
                btn.disabled = false;
                btn.textContent = originalLabel;
            }, 10);
        };
        consistency5Btn.onclick = () => runConsistency(5);
        consistency6Btn.onclick = () => runConsistency(6);

        renderHand();
    }

    // Simulates `trials` opening hands drawn from `pool` (already copies-
    // weighted by buildDrawPool) without replacement per hand, classifying
    // each card with the same classifyCardRole() heuristic the Analysis tab
    // uses. A card's role never changes between copies, so it's cached by
    // name to avoid redundantly re-running the regex checks per copy.
    runConsistencyTest(pool, handSize, trials = 10000) {
        const roleCache = new Map();
        const getRole = (card) => {
            if (!roleCache.has(card.name)) roleCache.set(card.name, classifyCardRole(card).role);
            return roleCache.get(card.name);
        };

        let starterHands = 0, extenderHands = 0, handtrapHands = 0, brickHands = 0, playableHands = 0;
        let starterTotal = 0;

        for (let t = 0; t < trials; t++) {
            const hand = this.shuffleSample(pool, handSize);
            let starters = 0, hasExtender = false, hasHandtrap = false, hasNonBrick = false;
            for (const card of hand) {
                const role = getRole(card);
                if (role === 'starter') { starters++; hasNonBrick = true; }
                else if (role === 'extender') { hasExtender = true; hasNonBrick = true; }
                else if (role === 'handtrap') { hasHandtrap = true; hasNonBrick = true; }
                else if (role !== 'brick') { hasNonBrick = true; } // generic "other" staples still count as non-dead
            }
            if (starters > 0) starterHands++;
            if (hasExtender) extenderHands++;
            if (hasHandtrap) handtrapHands++;
            if (!hasNonBrick) brickHands++; // every card in hand classified as brick
            if (starters > 0 || hasHandtrap) playableHands++;
            starterTotal += starters;
        }

        return {
            trials, handSize,
            starterPct: (starterHands / trials) * 100,
            extenderPct: (extenderHands / trials) * 100,
            handtrapPct: (handtrapHands / trials) * 100,
            brickPct: (brickHands / trials) * 100,
            playablePct: (playableHands / trials) * 100,
            avgStarters: starterTotal / trials,
        };
    }

    renderConsistencyResults(resultsWrap, stats, handSize) {
        resultsWrap.style.display = 'block';
        resultsWrap.empty();

        const heading = resultsWrap.createEl('div');
        heading.textContent = `📊 Consistency — ${stats.trials.toLocaleString()} hands of ${handSize}`;
        heading.style.cssText = 'font-family: monospace; font-size: 0.85em; font-weight: bold; color: #4ade80; margin-bottom: 10px;';

        const rows = [
            ['🟢 Starter in hand', stats.starterPct, '#4ade80'],
            ['🔵 Extender in hand', stats.extenderPct, '#60a5fa'],
            ['🪤 Hand trap in hand', stats.handtrapPct, '#f87171'],
            ['✅ Playable hand (starter or hand trap)', stats.playablePct, '#facc15'],
            ['🟤 Brick (dead hand)', stats.brickPct, '#a8a29e'],
        ];
        for (const [label, pct, color] of rows) {
            const row = resultsWrap.createEl('div');
            row.style.cssText = 'margin-bottom: 8px;';
            const labelRow = row.createEl('div');
            labelRow.style.cssText = 'display: flex; justify-content: space-between; font-family: monospace; font-size: 0.8em; color: #cbd5e1; margin-bottom: 3px;';
            labelRow.createEl('span', { text: label });
            labelRow.createEl('span', { text: `${pct.toFixed(1)}%` });
            const barBg = row.createEl('div');
            barBg.style.cssText = 'height: 8px; background: #1f2937; border-radius: 4px; overflow: hidden;';
            const barFill = barBg.createEl('div');
            barFill.style.cssText = `height: 100%; width: ${pct}%; background: ${color}; border-radius: 4px; transition: width .4s;`;
        }

        const avgLine = resultsWrap.createEl('div');
        avgLine.style.cssText = 'font-family: monospace; font-size: 0.78em; color: #94a3b8; margin-top: 6px;';
        avgLine.textContent = `Average starters per hand: ${stats.avgStarters.toFixed(2)}`;
    }

    // Lightweight, non-interactive card tile for the hand simulator — unlike
    // renderCard(), clicking it doesn't toggle "owned" in the deck template.
    renderHandCard(card, container) {
        const rarityColor = RARITY_COLOR[card.rarity] || '#94a3b8';
        const wrap = container.createEl('div');
        wrap.style.cssText = `
            display: flex; flex-direction: column; align-items: center;
            background: #111827; border-radius: 8px; padding: 8px 5px 9px;
            border: 1.5px solid ${rarityColor}77; width: 106px;
        `;
        wrap.title = `${card.name}\n${card.type}\n${card.desc?.slice(0, 140) ?? ''}…`;

        const img = wrap.createEl('img');
        img.src = card.image;
        img.style.cssText = 'width: 82px; border-radius: 4px; display: block;';

        const nameEl = wrap.createEl('div');
        nameEl.textContent = card.name.length > 17 ? card.name.slice(0, 15) + '…' : card.name;
        nameEl.style.cssText = `
            font-size: 0.6em; text-align: center; color: #cbd5e1;
            margin-top: 5px; line-height: 1.3; max-width: 100px;
            font-family: monospace;
        `;

        if (HAND_TRAPS.includes(card.name)) {
            const tag = wrap.createEl('div');
            tag.textContent = '🪤 Hand Trap';
            tag.style.cssText = 'font-size: 0.54em; color: #facc15; margin-top: 2px; font-family: monospace;';
        }
    }

    // Shared by the quick-add text form and ComboBuilderUI — appends a combo
    // line under a matching category heading (or the first COMBO section, or
    // a brand-new section if neither exists), reparses this.combos, and
    // returns whether it succeeded so callers can decide what to do next.
    async saveComboText(text, cat, categories) {
        const category = (cat && cat.trim()) || categories?.[0] || 'General';
        const newLine = `- [ ] ${text}`;

        const fileContent = await this.plugin.readTemplate();
        if (!fileContent) { new Notice('No active file to save to.'); return false; }

        let updated = fileContent;
        const catHeadingRe = new RegExp(`(^#{1,6}[^\\n]*${category.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*)`, 'im');
        const comboHeadingRe = /^(#{1,6}[^\n]*\bcombo\b[^\n]*)/im;

        if (catHeadingRe.test(updated)) {
            updated = updated.replace(catHeadingRe, (m) => `${m}\n${newLine}`);
        } else if (comboHeadingRe.test(updated)) {
            updated = updated.replace(comboHeadingRe, (m) => `${m}\n${newLine}`);
        } else {
            updated += `\n\n## 🧠 COMBO CHECKLIST — ${category}\n${newLine}\n`;
        }

        await this.plugin.writeTemplate(updated);
        this.combos = parseCombosFromMarkdown(updated);
        return true;
    }

    // Shared delete/update for combo lines — both act on combo.rawText (the
    // exact original markdown line captured by the parser) so they can find
    // and replace/remove precisely the right line without disturbing anything
    // else in the note, then reparse this.combos from the saved result.
    async deleteComboText(rawText) {
        const fileContent = await this.plugin.readTemplate();
        if (!fileContent) { new Notice('No active file to save to.'); return false; }
        const idx = fileContent.indexOf(rawText);
        if (idx === -1) { new Notice('Could not find that combo line in the note — it may have changed.'); return false; }
        let end = idx + rawText.length;
        if (fileContent[end] === '\r' && fileContent[end + 1] === '\n') end += 2;
        else if (fileContent[end] === '\n') end += 1;
        const updated = fileContent.slice(0, idx) + fileContent.slice(end);
        await this.plugin.writeTemplate(updated);
        this.combos = parseCombosFromMarkdown(updated);
        return true;
    }

    async updateComboText(oldRawText, newText, learned) {
        const fileContent = await this.plugin.readTemplate();
        if (!fileContent) { new Notice('No active file to save to.'); return false; }
        if (!fileContent.includes(oldRawText)) { new Notice('Could not find that combo line in the note — it may have changed.'); return false; }
        const newLine = `- [${learned ? 'x' : ' '}] ${newText}`;
        const updated = fileContent.replace(oldRawText, newLine);
        await this.plugin.writeTemplate(updated);
        this.combos = parseCombosFromMarkdown(updated);
        return true;
    }

    renderCombos(container) {
        const allCombos = this.combos || [];

        // ── Top controls bar ────────────────────────────────────────────────
        const controls = container.createEl('div');
        controls.style.cssText = `
            display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; align-items: center;
        `;

        // Search box
        const searchBox = controls.createEl('input');
        searchBox.placeholder = '🔍 Search combos…';
        searchBox.style.cssText = `
            flex: 1; min-width: 160px; background: #1f2937; border: 1px solid #374151;
            border-radius: 6px; padding: 6px 10px; color: #e2e8f0;
            font-size: 0.82em; outline: none; font-family: monospace;
        `;
        searchBox.addEventListener('focus', () => searchBox.style.borderColor = '#a78bfa');
        searchBox.addEventListener('blur', () => searchBox.style.borderColor = '#374151');

        // Category filter dropdown
        const categories = [...new Set(allCombos.map(c => c.category))];
        const filterSel = controls.createEl('select');
        filterSel.style.cssText = `
            background: #1f2937; border: 1px solid #374151; border-radius: 6px;
            padding: 6px 10px; color: #e2e8f0; font-size: 0.82em;
            font-family: monospace; cursor: pointer; outline: none;
        `;
        const allOpt = filterSel.createEl('option', { text: 'All categories', value: '' });
        categories.forEach(cat => {
            filterSel.createEl('option', { text: cat, value: cat });
        });

        // Filter buttons: All / Unlearned / Learned
        const mkFilterBtn = (label, val, active) => {
            const b = controls.createEl('button');
            b.textContent = label;
            b.dataset.filterVal = val;
            b.style.cssText = `
                background: ${active ? '#a78bfa22' : '#1f2937'}; color: ${active ? '#a78bfa' : '#6b7280'};
                border: 1px solid ${active ? '#a78bfa' : '#374151'};
                padding: 5px 11px; border-radius: 6px; cursor: pointer;
                font-size: 0.78em; font-family: monospace; font-weight: bold;
                transition: all .12s;
            `;
            return b;
        };
        const btnAll = mkFilterBtn('All', 'all', true);
        const btnUnlearned = mkFilterBtn('⬜ Unlearned', 'unlearned', false);
        const btnLearned = mkFilterBtn('✅ Learned', 'learned', false);
        controls.appendChild(btnAll);
        controls.appendChild(btnUnlearned);
        controls.appendChild(btnLearned);

        // Add Combo button
        const addComboBtn = controls.createEl('button');
        addComboBtn.textContent = '＋ Add Combo';
        addComboBtn.style.cssText = `
            background: #4c1d95; color: #c4b5fd; border: 1px solid #7c3aed;
            padding: 5px 13px; border-radius: 6px; cursor: pointer;
            font-size: 0.78em; font-family: monospace; font-weight: bold;
            transition: opacity .12s; margin-left: auto;
        `;
        addComboBtn.onmouseenter = () => addComboBtn.style.opacity = '0.75';
        addComboBtn.onmouseleave = () => addComboBtn.style.opacity = '1';

        // ── Add Combo inline form ────────────────────────────────────────────
        const addForm = container.createEl('div');
        addForm.style.cssText = `
            display: none; background: #111827; border: 1px solid #7c3aed;
            border-radius: 10px; padding: 14px 16px; margin-bottom: 14px; gap: 8px;
            flex-direction: column;
        `;

        const formRow1 = addForm.createEl('div');
        formRow1.style.cssText = 'display: flex; gap: 8px; flex-wrap: wrap;';

        const newComboInput = formRow1.createEl('input');
        newComboInput.placeholder = 'Combo description (e.g. Chamber → SS Sheou → Set Tidying)';
        newComboInput.style.cssText = `
            flex: 1; min-width: 200px; background: #1f2937; border: 1px solid #4c1d95;
            border-radius: 6px; padding: 7px 11px; color: #e2e8f0;
            font-size: 0.84em; font-family: monospace; outline: none;
        `;
        newComboInput.addEventListener('focus', () => newComboInput.style.borderColor = '#a78bfa');
        newComboInput.addEventListener('blur', () => newComboInput.style.borderColor = '#4c1d95');

        const catInput = formRow1.createEl('input');
        catInput.placeholder = 'Category (optional)';
        catInput.value = categories[0] || 'General';
        catInput.style.cssText = `
            width: 160px; background: #1f2937; border: 1px solid #4c1d95;
            border-radius: 6px; padding: 7px 11px; color: #e2e8f0;
            font-size: 0.84em; font-family: monospace; outline: none;
        `;
        catInput.addEventListener('focus', () => catInput.style.borderColor = '#a78bfa');
        catInput.addEventListener('blur', () => catInput.style.borderColor = '#4c1d95');

        const formRow2 = addForm.createEl('div');
        formRow2.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';

        const cancelComboBtn = formRow2.createEl('button', { text: 'Cancel' });
        cancelComboBtn.style.cssText = `
            background: #374151; color: #e2e8f0; border: none;
            padding: 6px 14px; border-radius: 6px; cursor: pointer;
            font-size: 0.8em; font-family: monospace;
        `;
        const saveComboBtn = formRow2.createEl('button', { text: '💾 Save Combo' });
        saveComboBtn.style.cssText = `
            background: #7c3aed; color: #fff; border: none;
            padding: 6px 14px; border-radius: 6px; cursor: pointer;
            font-size: 0.8em; font-family: monospace; font-weight: bold;
        `;

        addForm.appendChild(formRow1);
        addForm.appendChild(formRow2);

        addComboBtn.onclick = () => {
            addForm.style.display = addForm.style.display === 'flex' ? 'none' : 'flex';
            if (addForm.style.display === 'flex') newComboInput.focus();
        };
        cancelComboBtn.onclick = () => { addForm.style.display = 'none'; newComboInput.value = ''; };

        saveComboBtn.onclick = async () => {
            const text = newComboInput.value.trim();
            if (!text) return new Notice('Enter a combo description.');
            const cat = catInput.value.trim();
            const ok = await this.saveComboText(text, cat, categories);
            if (!ok) return;

            newComboInput.value = '';
            addForm.style.display = 'none';
            this.switchTab('combos');
            this.setStatus(`✅ Combo added: "${text.slice(0, 50)}"`);
        };
        newComboInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveComboBtn.click(); });

        // Visual Combo Builder — step-by-step picker with autocomplete against
        // known cards (this.allCards + comboCardCache) and a live preview,
        // instead of hand-typing the arrow-joined text. Saves through the same
        // saveComboText() path as the quick-add form above.
        const builderBtn = controls.createEl('button');
        builderBtn.textContent = '🧩 Visual Builder';
        builderBtn.style.cssText = `
            background: #1e1b4b; color: #a78bfa; border: 1px solid #4c1d95;
            padding: 5px 13px; border-radius: 6px; cursor: pointer;
            font-size: 0.78em; font-family: monospace; font-weight: bold;
            transition: opacity .12s;
        `;
        builderBtn.onmouseenter = () => builderBtn.style.opacity = '0.75';
        builderBtn.onmouseleave = () => builderBtn.style.opacity = '1';
        builderBtn.onclick = () => new ComboBuilderUI(this.app, this.plugin, this, categories).open();

        // ── List area ────────────────────────────────────────────────────────
        const listArea = container.createEl('div');

        // ── Render function (reactive to filters) ───────────────────────────
        const re_render = () => {
            listArea.empty();
            const query = searchBox.value.trim().toLowerCase();
            const catFilter = filterSel.value;
            const activeLearnFilter = document.querySelector('[data-filter-active="true"]')?.dataset.filterVal || 'all';

            let combos = allCombos.filter(c => {
                if (catFilter && c.category !== catFilter) return false;
                if (activeLearnFilter === 'learned' && !c.learned) return false;
                if (activeLearnFilter === 'unlearned' && c.learned) return false;
                if (query && !c.text.toLowerCase().includes(query) && !c.category.toLowerCase().includes(query)) return false;
                return true;
            });

            if (combos.length === 0) {
                const empty = listArea.createEl('div');
                empty.style.cssText = 'color: #4b5563; font-family: monospace; font-size: 0.85em; padding: 30px; text-align: center;';
                empty.textContent = allCombos.length === 0
                    ? 'No combos found. Add a 🧠 COMBO CHECKLIST section to your note, or use the ＋ Add Combo button above.'
                    : 'No combos match the current filter.';
                return;
            }

            // Progress banner (overall, not filtered)
            const total = allCombos.length;
            const learned = allCombos.filter(c => c.learned).length;
            const pct = total > 0 ? Math.round((learned / total) * 100) : 0;
            const banner = listArea.createEl('div');
            banner.style.cssText = `
                background: #111827; border: 1px solid #1f2937; border-radius: 10px;
                padding: 12px 18px; margin-bottom: 16px; display: flex;
                align-items: center; gap: 16px; flex-wrap: wrap;
            `;
            const bannerText = banner.createEl('div');
            bannerText.style.cssText = 'font-family: monospace; font-size: 0.84em; color: #94a3b8;';
            bannerText.textContent = `🧠 ${learned} / ${total} combos learned`;
            const barWrap = banner.createEl('div');
            barWrap.style.cssText = 'flex: 1; min-width: 120px; height: 8px; background: #1f2937; border-radius: 4px; overflow: hidden;';
            const barFill = barWrap.createEl('div');
            barFill.style.cssText = `height: 100%; width: ${pct}%; background: linear-gradient(90deg, #a78bfa, #818cf8); border-radius: 4px; transition: width .4s;`;
            const pctLabel = banner.createEl('div');
            pctLabel.style.cssText = 'font-family: monospace; font-size: 0.8em; color: #a78bfa; font-weight: bold; min-width: 36px;';
            pctLabel.textContent = `${pct}%`;

            // Group by category
            const grouped = {};
            combos.forEach(c => {
                if (!grouped[c.category]) grouped[c.category] = [];
                grouped[c.category].push(c);
            });

            for (const [cat, items] of Object.entries(grouped)) {
                const section = listArea.createEl('div');
                section.style.cssText = 'margin-bottom: 20px;';

                // Category header — collapsible
                const catHeader = section.createEl('div');
                catHeader.style.cssText = `
                    font-family: monospace; font-size: 0.78em; font-weight: bold;
                    color: #a78bfa; text-transform: uppercase; letter-spacing: 0.08em;
                    padding: 0 0 6px 2px; border-bottom: 1px solid #1f2937; margin-bottom: 10px;
                    cursor: pointer; display: flex; justify-content: space-between; align-items: center;
                    user-select: none;
                `;
                const catLearned = items.filter(i => i.learned).length;

                // Mini progress bar per category
                const catPct = items.length > 0 ? Math.round((catLearned / items.length) * 100) : 0;
                const catBar = `<span style="display:inline-block;width:48px;height:5px;background:#1f2937;border-radius:3px;vertical-align:middle;margin:0 6px;overflow:hidden"><span style="display:block;height:100%;width:${catPct}%;background:#a78bfa;border-radius:3px"></span></span>`;
                catHeader.innerHTML = `<span>${cat}  (${catLearned}/${items.length})${catBar}</span><span class="collapse-arrow">▾</span>`;

                const itemsWrap = section.createEl('div');
                let collapsed = false;
                catHeader.onclick = () => {
                    collapsed = !collapsed;
                    itemsWrap.style.display = collapsed ? 'none' : 'block';
                    catHeader.querySelector('.collapse-arrow').textContent = collapsed ? '▸' : '▾';
                };

                items.forEach(combo => {
                    const row = itemsWrap.createEl('div');
                    row.style.cssText = `
                        display: flex; align-items: flex-start; gap: 10px;
                        padding: 9px 12px; border-radius: 8px; cursor: pointer;
                        transition: background .12s; margin-bottom: 5px;
                        background: ${combo.learned ? '#0f2318' : '#111827'};
                        border: 1px solid ${combo.learned ? '#166534' : '#1f2937'};
                    `;
                    row.onmouseenter = () => row.style.background = combo.learned ? '#14532d' : '#1f2937';
                    row.onmouseleave = () => row.style.background = combo.learned ? '#0f2318' : '#111827';

                    // Checkbox
                    const check = row.createEl('div');
                    check.style.cssText = `
                        width: 18px; height: 18px; border-radius: 4px; flex-shrink: 0; margin-top: 2px;
                        border: 2px solid ${combo.learned ? '#4ade80' : '#374151'};
                        background: ${combo.learned ? '#4ade80' : 'transparent'};
                        display: flex; align-items: center; justify-content: center;
                        font-size: 0.7em; color: #0d0f1a; font-weight: bold; transition: all .15s;
                    `;
                    check.textContent = combo.learned ? '✓' : '';

                    // Combo content column
                    const contentCol = row.createEl('div');
                    contentCol.style.cssText = 'flex: 1; display: flex; flex-direction: column; gap: 6px;';

                    // Combo text with → highlighting and card-name chip detection
                    const textEl = contentCol.createEl('div');
                    textEl.style.cssText = `
                        font-family: monospace; font-size: 0.85em;
                        color: ${combo.learned ? '#86efac' : '#cbd5e1'};
                        line-height: 1.6;
                    `;

                    // Build a regex that splits the plain text on: arrows AND known card names.
                    // Work entirely on plain text → build real DOM nodes, never chain innerHTML.
                    // Use comboCardCache (includes deck cards + on-demand fetched combo cards)
                    const allKnownCards = new Map([
                        ...this.allCards.map(c => [c.name.toLowerCase(), c]),
                        ...this.comboCardCache
                    ]);
                    const sortedCards = [...allKnownCards.values()]
                        .filter((c, i, arr) => arr.findIndex(x => x.name === c.name) === i)
                        .sort((a, b) => b.name.length - a.name.length);
                    const cardNameSet = allKnownCards;

                    // Build one big alternation: card names (longest first) | arrow tokens
                    const cardPatterns = sortedCards.map(c =>
                        c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
                    );
                    const splitRe = cardPatterns.length
                        ? new RegExp(`(${cardPatterns.join('|')}|→|->|➜)`, 'gi')
                        : /(→|->|➜)/gi;

                    const parts = combo.text.split(splitRe);
                    for (const part of parts) {
                        if (!part) continue;
                        const lc = part.toLowerCase();
                        const matchedCard = cardNameSet.get(lc);
                        if (matchedCard) {
                            // Card chip — built as a real DOM element
                            const chip = textEl.createEl('span');
                            chip.title = matchedCard.name;
                            chip.style.cssText = `
                                display:inline-flex;align-items:center;
                                background:#1e1b4b;border:1px solid #4c1d95;
                                border-radius:4px;padding:0 5px 0 2px;margin:0 2px;
                                vertical-align:middle;font-size:0.93em;color:#c4b5fd;cursor:default;
                            `;
                            if (matchedCard.image) {
                                const img = chip.createEl('img');
                                img.src = matchedCard.image;
                                img.style.cssText = 'width:22px;height:32px;object-fit:cover;border-radius:2px;margin-right:4px;flex-shrink:0;';
                            }
                            chip.appendChild(document.createTextNode(matchedCard.name));
                        } else if (/^(→|->|➜)$/.test(part)) {
                            // Arrow token
                            const arrow = textEl.createEl('span');
                            arrow.textContent = part;
                            arrow.style.cssText = 'color:#a78bfa;font-weight:bold;padding:0 3px;font-size:1.05em;';
                        } else {
                            // Plain text segment
                            textEl.appendChild(document.createTextNode(part));
                        }
                    }

                    // Step-by-step parsing: split on → and show full card art if 2+ steps.
                    // Recognized card names render as a full thumbnail + label. A step
                    // naming multiple cards in one segment ("A / B loop", "A + B") renders
                    // each resolvable card as its own mini thumbnail. Anything left
                    // unresolved falls back to the old numbered text chip.
                    const mkCardBlock = (wrap, card, { width = 56, imgWidth = 52, font = '0.58em' } = {}) => {
                        const cardBox = wrap.createEl('div');
                        cardBox.style.cssText = `display: flex; flex-direction: column; align-items: center; width: ${width}px;`;
                        if (card.image) {
                            const img = cardBox.createEl('img');
                            img.src = card.image;
                            img.title = card.name;
                            img.style.cssText = `width: ${imgWidth}px; border-radius: 4px; display: block; box-shadow: 0 0 0 1px #4c1d95;`;
                        }
                        const label = cardBox.createEl('div');
                        const maxLen = width <= 50 ? 13 : 14;
                        label.textContent = card.name.length > maxLen ? card.name.slice(0, maxLen - 2) + '…' : card.name;
                        label.title = card.name;
                        label.style.cssText = `font-size: ${font}; text-align: center; color: #c4b5fd; margin-top: 3px; font-family: monospace; line-height: 1.2;`;
                    };
                    const mkTextTag = (wrap, text, { numbered = null } = {}) => {
                        const chip = wrap.createEl('span');
                        chip.style.cssText = `
                            display: inline-flex; align-items: center; gap: 4px; align-self: center;
                            background: #0f172a; border: 1px solid #334155;
                            border-radius: 5px; padding: 2px 7px;
                            font-family: monospace; font-size: 0.72em; color: #94a3b8;
                        `;
                        if (numbered !== null) {
                            const numEl = chip.createEl('span');
                            numEl.style.cssText = 'color: #a78bfa; font-weight: bold; font-size: 0.9em;';
                            numEl.textContent = `${numbered}.`;
                            chip.appendChild(document.createTextNode(' ' + text));
                        } else {
                            chip.textContent = text;
                        }
                    };
                    const resolvePhrase = (phrase) => {
                        const direct = cardNameSet.get(phrase.toLowerCase());
                        if (direct) return direct;
                        // The card name may sit anywhere in the phrase, with notes
                        // before or after it — check every contiguous word window,
                        // longest first, so the most specific match wins.
                        const words = phrase.split(/\s+/);
                        for (let len = words.length - 1; len >= 1; len--) {
                            for (let start = 0; start <= words.length - len; start++) {
                                const candidate = words.slice(start, start + len).join(' ').trim();
                                const m = cardNameSet.get(candidate.toLowerCase());
                                if (m) return m;
                            }
                        }
                        return null;
                    };

                    const steps = combo.text.split(/→|->|➜/).map(s => s.trim()).filter(Boolean);
                    if (steps.length >= 1) {
                        const stepsWrap = contentCol.createEl('div');
                        stepsWrap.style.cssText = 'display: flex; gap: 6px; flex-wrap: wrap; align-items: flex-start; margin-top: 4px;';
                        let renderedAny = false;
                        steps.forEach((step, i) => {
                            const stepMatch = cardNameSet.get(step.toLowerCase());
                            const delim = step.includes('+') ? '+' : (step.includes('/') ? '/' : null);
                            if (stepMatch) {
                                mkCardBlock(stepsWrap, stepMatch);
                                renderedAny = true;
                            } else if (delim) {
                                // Compound step naming multiple cards, e.g. "Bystial + Maid"
                                // or "Wyverburster / Collapserpent loop" — resolve each side
                                // on its own so this doesn't collapse to a single card.
                                const subParts = step.split(/[/+]/).map(s => s.trim()).filter(Boolean);
                                const resolvedSubs = subParts.map(sub => ({ label: sub, card: resolvePhrase(sub) }));
                                const anyResolved = resolvedSubs.some(r => r.card);
                                if (anyResolved) {
                                    const groupWrap = stepsWrap.createEl('div');
                                    groupWrap.style.cssText = 'display: flex; align-items: flex-start; gap: 4px;';
                                    resolvedSubs.forEach((r, k) => {
                                        if (r.card) {
                                            mkCardBlock(groupWrap, r.card, { width: 48, imgWidth: 44, font: '0.55em' });
                                        } else {
                                            mkTextTag(groupWrap, r.label);
                                        }
                                        if (k < resolvedSubs.length - 1) {
                                            const sep = groupWrap.createEl('span');
                                            sep.textContent = delim;
                                            sep.style.cssText = 'align-self: center; color: #4b5563; font-size: 0.85em; margin: 0 1px;';
                                        }
                                    });
                                    renderedAny = true;
                                } else if (steps.length >= 2) {
                                    mkTextTag(stepsWrap, step, { numbered: i + 1 });
                                    renderedAny = true;
                                }
                            } else {
                                // No delimiter — the step may still be a single card name with
                                // a trailing note ("Accesscode OTK route", "Tidying (GY)").
                                const trimmedMatch = resolvePhrase(step);
                                if (trimmedMatch) {
                                    mkCardBlock(stepsWrap, trimmedMatch);
                                    renderedAny = true;
                                } else if (steps.length >= 2) {
                                    mkTextTag(stepsWrap, step, { numbered: i + 1 });
                                    renderedAny = true;
                                }
                                // steps.length === 1 and nothing resolves: skip — the title
                                // line above already shows this text, no need to duplicate it.
                            }
                            if (i < steps.length - 1) {
                                const arr = stepsWrap.createEl('span');
                                arr.textContent = '→';
                                arr.style.cssText = 'color: #4b5563; font-size: 1em; align-self: center; margin: 0 2px;';
                            }
                        });
                        if (!renderedAny) stepsWrap.remove();
                    }

                    row.appendChild(check);
                    row.appendChild(contentCol);

                    // Edit / Delete — stopPropagation so they don't also
                    // trigger the row's learned-toggle click handler below.
                    const actionsCol = row.createEl('div');
                    actionsCol.style.cssText = 'display: flex; gap: 2px; flex-shrink: 0; padding-top: 1px;';

                    const mkActionBtn = (icon) => {
                        const b = actionsCol.createEl('button');
                        b.textContent = icon;
                        b.style.cssText = `
                            background: none; border: none; cursor: pointer; font-size: 0.85em;
                            padding: 3px 6px; border-radius: 4px; opacity: 0.55; transition: opacity .12s, background .12s;
                        `;
                        b.onmouseenter = () => { b.style.opacity = '1'; b.style.background = '#1f2937'; };
                        b.onmouseleave = () => { if (!b.dataset.confirming) { b.style.opacity = '0.55'; b.style.background = 'none'; } };
                        return b;
                    };

                    const editBtn = mkActionBtn('✏️');
                    editBtn.title = 'Edit combo';
                    editBtn.onclick = (e) => {
                        e.stopPropagation();
                        new ComboBuilderUI(this.app, this.plugin, this, categories, combo).open();
                    };

                    const deleteBtn = mkActionBtn('🗑️');
                    deleteBtn.title = 'Delete combo';
                    deleteBtn.onclick = async (e) => {
                        e.stopPropagation();
                        if (!deleteBtn.dataset.confirming) {
                            deleteBtn.dataset.confirming = '1';
                            deleteBtn.textContent = '❗ confirm';
                            deleteBtn.style.opacity = '1';
                            deleteBtn.style.color = '#f87171';
                            setTimeout(() => {
                                if (deleteBtn.dataset.confirming) {
                                    delete deleteBtn.dataset.confirming;
                                    deleteBtn.textContent = '🗑️';
                                    deleteBtn.style.opacity = '0.55';
                                    deleteBtn.style.color = '';
                                }
                            }, 2500);
                            return;
                        }
                        const ok = await this.deleteComboText(combo.rawText);
                        if (!ok) return;
                        this.switchTab('combos');
                        this.setStatus(`🗑️ Combo deleted: "${combo.text.slice(0, 40)}"`);
                    };
                    row.appendChild(actionsCol);

                    // Click to toggle learned
                    row.onclick = async () => {
                        combo.learned = !combo.learned;
                        const fileContent = await this.plugin.readTemplate();
                        if (fileContent) {
                            const updated = updateComboCheckbox(fileContent, combo.rawText, combo.learned);
                            await this.plugin.writeTemplate(updated);
                            combo.rawText = combo.rawText.replace(/^- \[[ x]\]/, combo.learned ? '- [x]' : '- [ ]');
                        }
                        re_render();
                        this.setStatus(`${combo.learned ? '☑' : '☐'} "${combo.text.slice(0, 40)}" marked ${combo.learned ? 'learned' : 'unlearned'}`);
                        this.switchTab('combos');
                    };
                });
            }
        };

        // Filter button logic
        const filterBtns = [btnAll, btnUnlearned, btnLearned];
        filterBtns.forEach(btn => {
            btn.onclick = () => {
                filterBtns.forEach(b => {
                    b.dataset.filterActive = 'false';
                    b.style.background = '#1f2937';
                    b.style.color = '#6b7280';
                    b.style.borderColor = '#374151';
                });
                btn.dataset.filterActive = 'true';
                btn.style.background = '#a78bfa22';
                btn.style.color = '#a78bfa';
                btn.style.borderColor = '#a78bfa';
                re_render();
            };
        });
        btnAll.dataset.filterActive = 'true';

        searchBox.addEventListener('input', re_render);
        filterSel.addEventListener('change', re_render);

        container.appendChild(controls);
        container.appendChild(addForm);
        container.appendChild(listArea);
        re_render();
    }

    setStatus(msg) { if (this.statusBar) this.statusBar.textContent = msg; }

    async loadFromTemplate() {
        const content = await this.plugin.readTemplate();
        if (!content) {
            const msg = this.plugin.getActiveFile()
                ? `Could not read the active file.`
                : `No note is currently open.\nOpen your checklist note first, then reopen the deck builder.`;
            this.setStatus(`⚠️ ${msg}`);
            return new Notice(msg);
        }

        // Always reload combos from the latest file content
        this.combos = parseCombosFromMarkdown(content);

        const entries = parseCardsFromMarkdown(content);
        if (entries.length === 0) {
            this.setStatus('⚠️ No card entries found in template.');
            this.switchTab(this.activeTab);
            return;
        }

        this.decks = { main60: [], main40: [], extra: [] };
        this.allCards = [];
        this.setStatus(`Fetching ${entries.length} unique cards from template…`);

        let loaded = 0;
        for (const entry of entries) {
            const card = await this.plugin.fetchCard(entry.name);
            if (card) {
                card.owned = entry.owned;
                card.count = entry.count;
                card.deckGroup = entry.deckGroup || 'main60';
                const group = card.deckGroup in this.decks ? card.deckGroup : 'main60';
                this.decks[group].push(card);
                this.allCards.push(card);
            }
            loaded++;
            this.setStatus(`Loading ${loaded}/${entries.length}: ${entry.name}`);
            await new Promise(r => setTimeout(r, 110));
        }

        const total = this.allCards.length;
        this.setStatus(`✅ ${total} cards loaded — use tabs to switch views. Click a card to toggle owned.`);
        this.switchTab(this.activeTab);
    }

    renderCard(card, container) {
        const rarityColor = RARITY_COLOR[card.rarity] || '#94a3b8';
        const owned = card.owned !== false;

        const wrap = container.createEl('div');
        wrap.style.cssText = `
            display: flex; flex-direction: column; align-items: center;
            background: #111827; border-radius: 8px; padding: 8px 5px 9px;
            border: 1.5px solid ${owned ? rarityColor + '77' : '#1f2937'};
            cursor: pointer; transition: transform .15s, border-color .15s, opacity .2s;
            position: relative; opacity: ${owned ? '1' : '0.45'};
        `;
        wrap.title = `${card.name}\n${card.type}\n${card.desc?.slice(0, 140) ?? ''}…`;

        wrap.onmouseenter = () => {
            wrap.style.transform = 'scale(1.06)';
            wrap.style.borderColor = rarityColor;
        };
        wrap.onmouseleave = () => {
            wrap.style.transform = 'scale(1)';
            wrap.style.borderColor = card.owned !== false ? rarityColor + '77' : '#1f2937';
        };

        // Owned indicator dot (top-right)
        const dot = wrap.createEl('div');
        dot.style.cssText = `
            position: absolute; top: 5px; right: 5px;
            width: 8px; height: 8px; border-radius: 50%;
            background: ${owned ? '#4ade80' : '#ef4444'};
            box-shadow: 0 0 4px ${owned ? '#4ade8088' : '#ef444488'};
        `;

        // Count badge (top-left)
        if (card.count && card.count > 1) {
            const badge = wrap.createEl('div');
            badge.textContent = `×${card.count}`;
            badge.style.cssText = `
                position: absolute; top: 4px; left: 4px;
                background: #374151; color: #e2e8f0;
                font-size: 0.6em; padding: 1px 5px; border-radius: 8px;
                font-family: monospace; font-weight: bold;
            `;
        }

        // Card image
        const img = wrap.createEl('img');
        img.src = card.image;
        img.style.cssText = 'width: 82px; border-radius: 4px; display: block; pointer-events: none;';

        // Card name
        const nameEl = wrap.createEl('div');
        nameEl.textContent = card.name.length > 17 ? card.name.slice(0, 15) + '…' : card.name;
        nameEl.style.cssText = `
            font-size: 0.6em; text-align: center; color: #cbd5e1;
            margin-top: 5px; line-height: 1.3; max-width: 100px;
            font-family: monospace;
        `;

        // Rarity label
        const rarityEl = wrap.createEl('div');
        rarityEl.textContent = RARITY_LABEL[card.rarity] || card.rarity;
        rarityEl.style.cssText = `font-size: 0.58em; font-weight: bold; color: ${rarityColor}; margin-top: 2px; font-family: monospace;`;

        // Ban status (Master Duel — falls back to Unlimited for cards not in
        // md-banlist.json, which also covers cards fetched before that file existed)
        const banStatus = card.ban_md || this.plugin.getBanStatusMD(card.konami_id);
        if (banStatus && banStatus !== 'Unlimited') {
            const banEl = wrap.createEl('div');
            banEl.textContent = `⚠ MD: ${banStatus}`;
            banEl.style.cssText = 'font-size: 0.54em; color: #f87171; margin-top: 2px; font-family: monospace;';
        }

        // Own-vs-need indicator, from the Collection note — only shown once
        // a collection has actually been loaded, so an empty/missing
        // collection doesn't paint every tile red.
        if (this.collectionMap && this.collectionMap.size > 0) {
            const have = this.collectionMap.get(card.name.toLowerCase())?.count || 0;
            const need = card.count || 1;
            const haveEl = wrap.createEl('div');
            haveEl.textContent = `📦 ${have}/${need}`;
            haveEl.style.cssText = `font-size: 0.54em; margin-top: 2px; font-family: monospace; color: ${have >= need ? '#4ade80' : '#f87171'};`;
        }

        // Remove button (bottom-right) — removes ONE copy of this card from
        // this deck group (decrements ×N, or deletes the line once the last
        // copy is gone). Faint until hovered so it doesn't compete visually
        // with the rest of the tile.
        const removeBtn = wrap.createEl('div');
        removeBtn.textContent = '✕';
        removeBtn.title = card.count > 1
            ? `Remove 1 copy of "${card.name}" (×${card.count})`
            : `Remove "${card.name}" from this deck`;
        removeBtn.style.cssText = `
            position: absolute; bottom: 4px; right: 5px;
            width: 15px; height: 15px; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            background: #1f2937; color: #f87171; font-size: 0.62em;
            font-family: monospace; font-weight: bold; line-height: 1;
            opacity: 0.45; transition: opacity .15s, background .15s;
            cursor: pointer;
        `;
        removeBtn.onmouseenter = () => { removeBtn.style.opacity = '1'; removeBtn.style.background = '#7f1d1d'; };
        removeBtn.onmouseleave = () => { removeBtn.style.opacity = '0.45'; removeBtn.style.background = '#1f2937'; };
        removeBtn.onclick = async (e) => {
            e.stopPropagation(); // don't also trigger the tile's owned-toggle
            await this.removeCardFromDeck(card);
        };

        // Click = toggle owned in template
        wrap.onclick = async () => {
            card.owned = !card.owned;
            wrap.style.opacity = card.owned ? '1' : '0.45';
            wrap.style.borderColor = card.owned ? rarityColor + '77' : '#1f2937';
            dot.style.background = card.owned ? '#4ade80' : '#ef4444';
            dot.style.boxShadow = `0 0 4px ${card.owned ? '#4ade8088' : '#ef444488'}`;

            const content = await this.plugin.readTemplate();
            if (content) {
                await this.plugin.writeTemplate(updateCardCheckbox(content, card.name, card.owned));
                this.setStatus(`${card.owned ? '☑' : '☐'} "${card.name}" marked ${card.owned ? 'owned' : 'unowned'} in template`);
            }
        };
    }

    async saveCardToTemplate(card) {
        const content = await this.plugin.readTemplate();
        if (!content) {
            this.setStatus(`⚠️ Could not read the active file — "${card.name}" was not saved.`);
            return;
        }

        // Note: unlike before, an existing line for this card is no longer a
        // reason to skip the write — upsertCardInTemplate rewrites it in
        // place with the card's current (possibly just-incremented) count.
        const updated = upsertCardInTemplate(content, card);
        const success = await this.plugin.writeTemplate(updated);
        if (!success) {
            this.setStatus(`❌ Failed to save "${card.name}" — no active file found.`);
            return;
        }
        this.setStatus(`💾 "${card.name}" ×${card.count || 1} saved to template.`);
    }

    // Removes ONE copy of a card's line from its deck group in the template.
    // If that leaves the entry with count 0 (i.e. it was the last copy), the
    // tile is dropped from the in-memory decks/allCards; otherwise the tile
    // stays and just shows the decremented ×N. Scoped to card.deckGroup so
    // removing a card from one section (e.g. the 40-card variant) never
    // touches its entry in another (e.g. Main Deck).
    async removeCardFromDeck(card) {
        const group = card.deckGroup;
        if (!this.decks[group]) return;

        const content = await this.plugin.readTemplate();
        if (!content) {
            this.setStatus(`⚠️ Could not read the active file — "${card.name}" was not removed.`);
            return;
        }

        const { content: updated, removed, newCount } = decrementCardInTemplate(content, card.name, group);
        const success = await this.plugin.writeTemplate(updated);
        if (!success) {
            this.setStatus(`❌ Failed to remove "${card.name}" — no active file found.`);
            return;
        }

        if (removed) {
            this.decks[group] = this.decks[group].filter(c => c !== card);
            this.allCards = this.allCards.filter(c => c !== card);
            this.setStatus(`🗑️ "${card.name}" removed from template.`);
            new Notice(`🗑️ Removed "${card.name}"`);
        } else {
            card.count = newCount;
            this.setStatus(`➖ "${card.name}" now ×${newCount} in ${group}.`);
        }

        this.switchTab(this.activeTab);
    }

    // Checks main/extra deck sizes and per-card Master Duel copy limits.
    // Uses the 40-card variant as "the main deck" when it has cards (since
    // that's a deliberate, exact-40 build), otherwise the 40–60 main deck.
    // Copy limits are checked against main+extra combined (Side Deck isn't
    // tracked by this plugin, so it's excluded).
    validateDeck() {
        // Validate whichever main-deck tab the user is currently viewing.
        // If they're on a non-deck tab (Extra/Combos/Test Hand), default to
        // the primary 60-card Main Deck — not the 40-card variant — since
        // that's the deck being built unless the user is actively looking
        // at the variant tab.
        const onDeckTab = this.activeTab === 'main60' || this.activeTab === 'main40';
        const mainKey = onDeckTab ? this.activeTab : 'main60';
        const mainCards = this.decks[mainKey];
        const extraCards = this.decks.extra;

        const sumCopies = cards => cards.reduce((n, c) => n + (c.count || 1), 0);
        const mainCount = sumCopies(mainCards);
        const extraCount = sumCopies(extraCards);
        const mainMin = 40, mainMax = mainKey === 'main40' ? 40 : 60, extraMax = 15;

        const errors = [], warnings = [];
        if (mainCount < mainMin || mainCount > mainMax) {
            errors.push(`Main Deck has ${mainCount} cards (needs ${mainMin}${mainMax !== mainMin ? `–${mainMax}` : ''})`);
        }
        if (extraCount > extraMax) {
            errors.push(`Extra Deck has ${extraCount} cards (max ${extraMax})`);
        }

        const combined = new Map(); // name -> { total copies across main+extra, konami_id }
        for (const c of [...mainCards, ...extraCards]) {
            const prev = combined.get(c.name);
            combined.set(c.name, { total: (prev?.total || 0) + (c.count || 1), konami_id: c.konami_id });
        }
        for (const [name, { total, konami_id }] of combined) {
            const status = this.plugin.getBanStatusMD(konami_id);
            const limit = BANLIST_COPY_LIMIT[status] ?? 3;
            if (total > limit) {
                errors.push(limit === 0
                    ? `"${name}" is Forbidden in Master Duel (×${total} in deck)`
                    : `"${name}" exceeds its Master Duel limit — ${status}: ${total}/${limit}`);
            } else if (status !== 'Unlimited') {
                warnings.push(`"${name}" is ${status} in Master Duel (${total}/${limit})`);
            }
        }

        return { mainKey, mainCount, mainMin, mainMax, extraCount, extraMax, errors, warnings };
    }

    showValidation() {
        if (this.allCards.length === 0) return new Notice('No cards loaded.');
        const r = this.validateDeck();
        const valid = r.errors.length === 0;
        const lines = [
            valid ? '🟢 DECK VALID' : '🔴 DECK INVALID',
            '─────────────────',
            `${r.mainKey === 'main40' ? 'Main Deck (40)' : 'Main Deck'}   ${r.mainCount} / ${r.mainMax}`,
            `Extra Deck      ${r.extraCount} / ${r.extraMax}`,
        ];
        if (r.errors.length) {
            lines.push('', 'Errors:');
            r.errors.forEach(e => lines.push(`❌ ${e}`));
        }
        if (r.warnings.length) {
            lines.push('', 'Warnings:');
            r.warnings.forEach(w => lines.push(`⚠ ${w}`));
        }
        if (this.plugin.banlistMeta?.asOf) {
            lines.push('', `(Banlist as of ${this.plugin.banlistMeta.asOf})`);
        }
        new Notice(lines.join('\n'), 15000);
    }

    // Cards this deck (Main + Extra, whichever main-deck view is active vs
    // its 40/60 counterpart — matches validateDeck()'s mainKey logic) still
    // needs beyond what the Collection note says is owned, grouped by
    // rarity so it reads like a crafting shopping list.
    showCraftList() {
        if (this.allCards.length === 0) return new Notice('No cards loaded.');
        if (!this.collectionMap || this.collectionMap.size === 0) {
            return new Notice(`⚠️ No collection data loaded. Set up "${this.plugin.settings.collectionNotePath}" (Settings → 📦 Create Collection Note) first.`);
        }

        const onDeckTab = this.activeTab === 'main60' || this.activeTab === 'main40';
        const mainKey = onDeckTab ? this.activeTab : 'main60';
        const cards = [...this.decks[mainKey], ...this.decks.extra];

        const needed = new Map(); // name -> { need, rarity }
        for (const c of cards) {
            const prev = needed.get(c.name);
            needed.set(c.name, { need: (prev?.need || 0) + (c.count || 1), rarity: c.rarity });
        }

        const missing = [];
        const byRarity = { UR: 0, SR: 0, R: 0, N: 0 };
        for (const [name, { need, rarity }] of needed) {
            const have = this.collectionMap.get(name.toLowerCase())?.count || 0;
            const short = need - have;
            if (short > 0) {
                missing.push(`${name} [${rarity}]  need ${short} more`);
                byRarity[rarity in byRarity ? rarity : 'N'] += short;
            }
        }

        if (missing.length === 0) {
            return new Notice('✅ You already own every card in this deck!');
        }

        const lines = [
            `📦 MISSING FROM COLLECTION (${missing.length} cards)`,
            '─────────────────',
            ...missing,
            '',
            `Crafting: ◆ UR ${byRarity.UR}  ◇ SR ${byRarity.SR}  ● R ${byRarity.R}  ○ N ${byRarity.N}`
        ];
        new Notice(lines.join('\n'), 20000);
    }

    showStats() {
        if (this.allCards.length === 0) return new Notice('No cards loaded.');
        const total = this.allCards.length;
        const owned = this.allCards.filter(c => c.owned !== false).length;
        const monsters = this.allCards.filter(c => c.type?.includes('Monster')).length;
        const spells = this.allCards.filter(c => c.type?.includes('Spell')).length;
        const traps = this.allCards.filter(c => c.type?.includes('Trap')).length;
        const handTraps = this.allCards.filter(c => HAND_TRAPS.includes(c.name)).length;
        const ur = this.allCards.filter(c => c.rarity === 'UR').length;
        const sr = this.allCards.filter(c => c.rarity === 'SR').length;
        const r = this.allCards.filter(c => c.rarity === 'R').length;

        new Notice(
            `📊 Deck Stats\n` +
            `─────────────────\n` +
            `Unique cards: ${total}\n` +
            `Owned ✅: ${owned} / ${total}\n` +
            `Still needed: ${total - owned}\n\n` +
            `Monsters: ${monsters}  Spells: ${spells}  Traps: ${traps}\n` +
            `Hand Traps: ${handTraps}\n\n` +
            `◆ UR: ${ur}  ◇ SR: ${sr}  ● R: ${r}`
        );
    }

    onClose() { this.contentEl.empty(); }

    // ── Deck Analysis ────────────────────────────────────────────────────────
    // Heuristic Starter/Extender/Brick/Other breakdown (see classifyCardRole
    // near the top of the file). Percentages are copies-weighted (×N counts),
    // matching how often you'd actually draw each role — not just unique-card
    // counts. Extra Deck is excluded (see classifyCardRole).
    renderAnalysis(container) {
        if (!this.analysisDeck) {
            this.analysisDeck = this.decks.main40.length > 0 ? 'main40' : 'main60';
        }

        const controls = container.createEl('div');
        controls.style.cssText = 'display: flex; gap: 8px; margin-bottom: 14px; flex-wrap: wrap; align-items: center;';

        const mkToggle = (label, key) => {
            const b = controls.createEl('button');
            b.textContent = label;
            const active = this.analysisDeck === key;
            b.style.cssText = `
                background: ${active ? '#f472b622' : '#1f2937'}; color: ${active ? '#f472b6' : '#6b7280'};
                border: 1px solid ${active ? '#f472b6' : '#374151'};
                padding: 6px 13px; border-radius: 6px; cursor: pointer;
                font-size: 0.8em; font-family: monospace; font-weight: bold;
            `;
            b.onclick = () => {
                this.analysisDeck = key;
                container.empty();
                this.renderAnalysis(container);
            };
            return b;
        };
        mkToggle('🟦 Main Deck (60)', 'main60');
        mkToggle('🟢 40-Card Variant', 'main40');

        const note = controls.createEl('span');
        note.textContent = '🔍 Heuristic estimate from card text — not exact, use as a rough guide.';
        note.style.cssText = 'font-size: 0.7em; color: #6b7280; font-family: monospace; margin-left: auto;';

        const cards = this.decks[this.analysisDeck] || [];
        if (cards.length === 0) {
            const empty = container.createEl('div');
            empty.style.cssText = 'color: #4b5563; font-family: monospace; font-size: 0.85em; padding: 30px; text-align: center;';
            empty.textContent = `No cards loaded in ${this.analysisDeck === 'main40' ? 'the 40-Card Variant' : 'Main Deck'} yet.`;
            return;
        }

        const buckets = { starter: [], extender: [], handtrap: [], brick: [], other: [] };
        let totalCopies = 0;
        for (const card of cards) {
            const { role, reason } = classifyCardRole(card);
            const copies = card.count || 1;
            totalCopies += copies;
            buckets[role].push({ card, copies, reason });
        }

        // ── Deck composition (M/S/T ratio, level curve, attributes, avg ATK) ──
        this.renderDeckStats(container, cards);

        // ── Percentage bars ──────────────────────────────────────────────────
        const barsWrap = container.createEl('div');
        barsWrap.style.cssText = 'display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px;';
        for (const role of ['starter', 'extender', 'handtrap', 'brick', 'other']) {
            const items = buckets[role];
            const copies = items.reduce((n, i) => n + i.copies, 0);
            const pct = totalCopies > 0 ? Math.round((copies / totalCopies) * 100) : 0;
            const meta = ROLE_META[role];

            const row = barsWrap.createEl('div');
            const labelRow = row.createEl('div');
            labelRow.style.cssText = 'display: flex; justify-content: space-between; font-family: monospace; font-size: 0.82em; color: #cbd5e1; margin-bottom: 4px;';
            labelRow.createEl('span', { text: meta.label });
            labelRow.createEl('span', { text: `${copies} cards · ${pct}%` });

            const barBg = row.createEl('div');
            barBg.style.cssText = 'height: 10px; background: #1f2937; border-radius: 5px; overflow: hidden;';
            const barFill = barBg.createEl('div');
            barFill.style.cssText = `height: 100%; width: ${pct}%; background: ${meta.color}; border-radius: 5px; transition: width .4s;`;
        }

        // ── Per-card breakdown ───────────────────────────────────────────────
        for (const role of ['starter', 'extender', 'handtrap', 'brick', 'other']) {
            const items = buckets[role];
            if (items.length === 0) continue;
            const meta = ROLE_META[role];

            const section = container.createEl('div');
            section.style.cssText = 'margin-bottom: 16px;';
            const header = section.createEl('div');
            header.textContent = meta.label;
            header.style.cssText = `
                font-family: monospace; font-size: 0.78em; font-weight: bold; color: ${meta.color};
                text-transform: uppercase; letter-spacing: 0.08em; padding-bottom: 6px;
                border-bottom: 1px solid #1f2937; margin-bottom: 8px;
            `;

            for (const { card, copies, reason } of items) {
                const line = section.createEl('div');
                line.style.cssText = 'display: flex; justify-content: space-between; gap: 10px; padding: 4px 2px; font-family: monospace; font-size: 0.78em;';
                const nameSpan = line.createEl('span');
                nameSpan.style.cssText = 'color: #e2e8f0; white-space: nowrap;';
                nameSpan.textContent = `${card.name} ×${copies}`;
                nameSpan.title = reason;
                const reasonSpan = line.createEl('span');
                reasonSpan.style.cssText = 'color: #6b7280; text-align: right; max-width: 55%;';
                reasonSpan.textContent = reason;
            }
        }
    }

    // Composition stats in the spirit of dedicated deckbuilding sites (M/S/T
    // ratio, level curve, attribute spread, average ATK) — separate from the
    // Starter/Extender/Brick heuristic above, which is about combo function
    // rather than raw composition. Copies-weighted, like the role bars.
    renderDeckStats(container, cards) {
        const mst = { Monster: 0, Spell: 0, Trap: 0 };
        const levelCurve = {}; // level -> copies, monsters only
        const attributes = {}; // attribute -> copies, monsters only
        let atkTotal = 0, atkCount = 0;

        for (const card of cards) {
            const copies = card.count || 1;
            const type = card.type || '';
            const bucket = type.includes('Monster') ? 'Monster' : type.includes('Spell') ? 'Spell' : type.includes('Trap') ? 'Trap' : null;
            if (bucket) mst[bucket] += copies;

            if (bucket === 'Monster') {
                if (card.level != null && card.level !== '') {
                    levelCurve[card.level] = (levelCurve[card.level] || 0) + copies;
                }
                if (card.attribute) {
                    attributes[card.attribute] = (attributes[card.attribute] || 0) + copies;
                }
                if (typeof card.atk === 'number' && card.atk >= 0) {
                    atkTotal += card.atk * copies;
                    atkCount += copies;
                }
            }
        }

        const wrap = container.createEl('div');
        wrap.style.cssText = 'margin-bottom: 22px; padding-bottom: 18px; border-bottom: 1px solid #1f2937;';

        const heading = wrap.createEl('div');
        heading.textContent = '📊 Deck Composition';
        heading.style.cssText = 'font-family: monospace; font-size: 0.85em; font-weight: bold; color: #f472b6; margin-bottom: 10px;';

        // M/S/T ratio
        const mstTotal = mst.Monster + mst.Spell + mst.Trap;
        const mstRow = wrap.createEl('div');
        mstRow.style.cssText = 'display: flex; justify-content: space-between; font-family: monospace; font-size: 0.78em; color: #94a3b8; margin-bottom: 5px;';
        mstRow.createEl('span', { text: 'M / S / T' });
        mstRow.createEl('span', { text: `${mst.Monster} / ${mst.Spell} / ${mst.Trap}` });

        const mstBar = wrap.createEl('div');
        mstBar.style.cssText = 'display: flex; height: 10px; border-radius: 5px; overflow: hidden; margin-bottom: 16px; background: #1f2937;';
        const mstColors = { Monster: '#4ade80', Spell: '#60a5fa', Trap: '#f472b6' };
        for (const key of ['Monster', 'Spell', 'Trap']) {
            if (mst[key] === 0) continue;
            const seg = mstBar.createEl('div');
            const pct = mstTotal > 0 ? (mst[key] / mstTotal) * 100 : 0;
            seg.style.cssText = `width: ${pct}%; background: ${mstColors[key]};`;
        }

        // Average ATK
        if (atkCount > 0) {
            const avgAtk = Math.round(atkTotal / atkCount);
            const atkLine = wrap.createEl('div');
            atkLine.style.cssText = 'font-family: monospace; font-size: 0.78em; color: #94a3b8; margin-bottom: 16px;';
            atkLine.textContent = `Average ATK (monsters): ${avgAtk.toLocaleString()}`;
        }

        // Level/Rank curve
        const levels = Object.keys(levelCurve).map(Number).sort((a, b) => a - b);
        if (levels.length > 0) {
            const levelHeading = wrap.createEl('div');
            levelHeading.textContent = 'Level / Rank curve';
            levelHeading.style.cssText = 'font-family: monospace; font-size: 0.76em; color: #6b7280; margin-bottom: 6px;';

            const maxLevelCopies = Math.max(...levels.map(l => levelCurve[l]));
            const curveRow = wrap.createEl('div');
            curveRow.style.cssText = 'display: flex; align-items: flex-end; gap: 4px; height: 60px; margin-bottom: 16px;';
            for (let lvl = Math.min(...levels); lvl <= Math.max(...levels); lvl++) {
                const copies = levelCurve[lvl] || 0;
                const col = curveRow.createEl('div');
                col.style.cssText = 'display: flex; flex-direction: column; align-items: center; justify-content: flex-end; flex: 1; height: 100%;';
                const bar = col.createEl('div');
                const h = maxLevelCopies > 0 ? Math.max((copies / maxLevelCopies) * 40, copies > 0 ? 3 : 0) : 0;
                bar.style.cssText = `width: 100%; height: ${h}px; background: ${copies > 0 ? '#60a5fa' : 'transparent'}; border-radius: 2px 2px 0 0;`;
                bar.title = `Level/Rank ${lvl}: ${copies}`;
                const lbl = col.createEl('div');
                lbl.textContent = String(lvl);
                lbl.style.cssText = 'font-size: 0.6em; color: #6b7280; font-family: monospace; margin-top: 3px;';
            }
        }

        // Attribute spread
        const attrKeys = Object.keys(attributes);
        if (attrKeys.length > 0) {
            const attrHeading = wrap.createEl('div');
            attrHeading.textContent = 'Attributes';
            attrHeading.style.cssText = 'font-family: monospace; font-size: 0.76em; color: #6b7280; margin-bottom: 6px;';

            const attrColors = {
                DARK: '#a78bfa', LIGHT: '#fde68a', EARTH: '#a8a29e',
                WATER: '#60a5fa', FIRE: '#f87171', WIND: '#4ade80', DIVINE: '#f472b6',
            };
            const attrWrap = wrap.createEl('div');
            attrWrap.style.cssText = 'display: flex; flex-wrap: wrap; gap: 6px;';
            const monsterCopies = mst.Monster || 1;
            for (const attr of attrKeys.sort((a, b) => attributes[b] - attributes[a])) {
                const chip = attrWrap.createEl('div');
                const pct = Math.round((attributes[attr] / monsterCopies) * 100);
                chip.style.cssText = `
                    font-family: monospace; font-size: 0.72em; padding: 3px 8px; border-radius: 10px;
                    background: ${attrColors[attr] || '#94a3b8'}22; color: ${attrColors[attr] || '#94a3b8'};
                    border: 1px solid ${attrColors[attr] || '#94a3b8'}55;
                `;
                chip.textContent = `${attr}: ${attributes[attr]} (${pct}%)`;
            }
        }
    }

    confirmApplyTemplate() {
        const file = this.plugin.getActiveFile();
        if (!file) {
            return new Notice('⚠️ No note is currently open. Open a note first.');
        }

        // Build a small inline confirmation modal
        const modal = new Modal(this.app);
        modal.titleEl.textContent = '⚠️ Apply blank template?';
        modal.contentEl.style.cssText = 'font-family: monospace; font-size: 0.88em; color: #e2e8f0;';

        modal.contentEl.createEl('p', {
            text: `This will REPLACE the entire contents of "${file.name}" with the blank deck template.`
        }).style.cssText = 'margin-bottom: 6px; color: #f87171; font-weight: bold;';

        modal.contentEl.createEl('p', {
            text: 'Any existing card data, checkboxes, and notes in this file will be permanently lost. Make sure you have a backup or are working on a fresh note.'
        }).style.cssText = 'margin-bottom: 16px; color: #94a3b8;';

        const btnRow = modal.contentEl.createEl('div');
        btnRow.style.cssText = 'display: flex; gap: 10px; justify-content: flex-end;';

        const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
        cancelBtn.style.cssText = `
            background: #374151; color: #e2e8f0; border: none;
            padding: 8px 16px; border-radius: 6px; cursor: pointer;
            font-size: 0.88em; font-family: monospace;
        `;
        cancelBtn.onclick = () => modal.close();

        const confirmBtn = btnRow.createEl('button', { text: '🗋 Yes, apply template' });
        confirmBtn.style.cssText = `
            background: #7f1d1d; color: #fca5a5; border: 1px solid #f87171;
            padding: 8px 16px; border-radius: 6px; cursor: pointer;
            font-size: 0.88em; font-family: monospace; font-weight: bold;
        `;
        confirmBtn.onclick = async () => {
            modal.close();
            const success = await this.plugin.writeTemplate(DECK_TEMPLATE);
            if (success) {
                // Reset UI state — the note is now a blank template
                this.decks = { main60: [], main40: [], extra: [] };
                this.allCards = [];
                this.switchTab(this.activeTab);
                this.setStatus(`✅ Template applied to "${file.name}". Fill in your deck and hit 🔄 Reload.`);
                new Notice(`✅ Blank template applied to "${file.name}"`);
            } else {
                new Notice('❌ Failed to apply template — no active file found.');
            }
        };

        modal.open();
    }
}

// Standalone collection browser: search/add cards, tabs by rarity, click a
// tile to add a copy, ✕ to remove one — same interaction pattern as the
// Deck Builder's card grid, but reading/writing the fixed collection note
// instead of whatever file is currently open.
class CollectionUI extends Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.cards = [];
        this.activeTab = 'UR';
        this.loading = false;
    }

    async onOpen() {
        this.modalEl.style.width = '820px';
        this.modalEl.style.maxWidth = '95vw';
        this.modalEl.style.maxHeight = '90vh';

        const { contentEl } = this;
        contentEl.style.cssText = `
            background: #0d0f1a; color: #e2e8f0; font-family: 'Georgia', serif;
            padding: 0; overflow: hidden; display: flex; flex-direction: column; height: 80vh;
        `;

        const header = contentEl.createEl('div');
        header.style.cssText = `
            background: linear-gradient(135deg, #1a0a2e 0%, #16213e 50%, #0f3460 100%);
            padding: 16px 24px 12px; border-bottom: 2px solid #e8c84a44; flex-shrink: 0;
        `;
        const title = header.createEl('h1');
        title.textContent = '📦 Collection Manager';
        title.style.cssText = `
            margin: 0 0 3px; font-size: 1.35em; font-weight: bold;
            background: linear-gradient(90deg, #e8c84a, #f5c3ff);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
        `;
        const sub = header.createEl('p');
        sub.style.cssText = 'margin: 0; font-size: 0.72em; color: #94a3b8; font-family: monospace;';
        sub.textContent = `📄 ${this.plugin.settings.collectionNotePath}  •  Click a card to add a copy, ✕ to remove one`;

        const toolbar = contentEl.createEl('div');
        toolbar.style.cssText = `
            display: flex; gap: 8px; padding: 10px 20px; background: #111827;
            border-bottom: 1px solid #1f2937; flex-shrink: 0; align-items: center; flex-wrap: wrap;
        `;
        const input = toolbar.createEl('input');
        input.placeholder = 'Add card by exact name…';
        input.style.cssText = `
            flex: 1; min-width: 160px; background: #1f2937; border: 1px solid #374151;
            border-radius: 6px; padding: 7px 12px; color: #e2e8f0; font-size: 0.88em;
            outline: none; font-family: monospace;
        `;
        input.addEventListener('focus', () => input.style.borderColor = '#e8c84a');
        input.addEventListener('blur', () => input.style.borderColor = '#374151');
        const addBtn = this.makeBtn(toolbar, '＋ Add', '#e8c84a', '#0d0f1a');
        const reloadBtn = this.makeBtn(toolbar, '🔄 Reload', '#c084f5', '#fff');
        const openNoteBtn = this.makeBtn(toolbar, '📂 Open Note', '#1f2937', '#f87171');
        openNoteBtn.title = 'Open the collection note directly for manual editing';

        const statsBar = contentEl.createEl('div');
        statsBar.style.cssText = `
            padding: 8px 22px; font-size: 0.72em; color: #94a3b8; background: #0d0f1a;
            flex-shrink: 0; font-family: monospace; border-bottom: 1px solid #1f2937;
        `;
        this.statsBar = statsBar;

        const tabBar = contentEl.createEl('div');
        tabBar.style.cssText = 'display: flex; gap: 0; flex-shrink: 0; background: #0d0f1a; border-bottom: 2px solid #1f2937;';
        const TABS = [
            { key: 'UR', label: '◆ UR', color: '#e8c84a' },
            { key: 'SR', label: '◇ SR', color: '#c084f5' },
            { key: 'R', label: '● R', color: '#60a5fa' },
            { key: 'N', label: '○ N', color: '#94a3b8' },
        ];
        this.tabEls = {};
        for (const tab of TABS) {
            const btn = tabBar.createEl('button');
            btn.textContent = tab.label;
            btn.style.cssText = `
                background: none; border: none; border-bottom: 3px solid transparent;
                padding: 9px 18px; color: #6b7280; cursor: pointer; font-size: 0.82em;
                font-weight: bold; font-family: monospace; transition: color .15s, border-color .15s;
            `;
            btn.onclick = () => this.switchTab(tab.key);
            this.tabEls[tab.key] = { btn, color: tab.color };
        }

        const statusBar = contentEl.createEl('div');
        statusBar.style.cssText = `
            padding: 3px 22px; font-size: 0.7em; color: #6b7280; background: #0d0f1a;
            flex-shrink: 0; font-family: monospace; border-bottom: 1px solid #1f2937;
        `;
        this.statusBar = statusBar;
        this.setStatus('Loading collection…');

        const grid = contentEl.createEl('div');
        grid.style.cssText = `
            flex: 1; overflow-y: auto; padding: 16px 20px; display: grid;
            grid-template-columns: repeat(auto-fill, minmax(108px, 1fr)); gap: 10px; align-content: start;
        `;
        this.grid = grid;

        input.addEventListener('keydown', e => { if (e.key === 'Enter') addBtn.click(); });
        addBtn.onclick = async () => {
            const name = input.value.trim();
            if (!name) return new Notice('Enter a card name.');
            if (this.loading) return;
            this.loading = true; addBtn.disabled = true;
            this.setStatus(`Fetching "${name}"…`);
            const fetched = await this.plugin.fetchCard(name);
            this.loading = false; addBtn.disabled = false;
            if (!fetched) {
                this.setStatus(`❌ Not found: "${name}"`);
                return new Notice(`Card not found: "${name}"`);
            }
            const existing = this.cards.find(c => c.name.toLowerCase() === fetched.name.toLowerCase());
            let entry;
            if (existing) {
                existing.count = (existing.count || 0) + 1;
                entry = existing;
            } else {
                fetched.count = 1;
                this.cards.push(fetched);
                entry = fetched;
            }
            input.value = '';
            this.switchTab(entry.rarity in this.tabEls ? entry.rarity : this.activeTab);
            this.setStatus(`✅ "${entry.name}" [${entry.rarity}] ×${entry.count} — saving…`);
            await this.saveCard(entry);
            this.renderStats();
        };
        reloadBtn.onclick = () => this.loadCollection();
        openNoteBtn.onclick = async () => {
            await this.plugin.openCollectionNote();
            this.close();
        };

        await this.loadCollection();
    }

    makeBtn(parent, label, bg, color) {
        const btn = parent.createEl('button');
        btn.textContent = label;
        btn.style.cssText = `
            background: ${bg}; color: ${color}; border: none; padding: 7px 13px;
            border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 0.8em;
            white-space: nowrap; transition: opacity .15s;
        `;
        btn.onmouseenter = () => btn.style.opacity = '0.75';
        btn.onmouseleave = () => btn.style.opacity = '1';
        return btn;
    }

    setStatus(msg) { if (this.statusBar) this.statusBar.textContent = msg; }

    renderStats() {
        if (!this.statsBar) return;
        const copies = { UR: 0, SR: 0, R: 0, N: 0 };
        const unique = { UR: 0, SR: 0, R: 0, N: 0 };
        for (const c of this.cards) {
            const r = c.rarity in copies ? c.rarity : 'N';
            copies[r] += c.count || 0;
            unique[r] += 1;
        }
        this.statsBar.textContent =
            `◆ UR ${unique.UR} unique / ${copies.UR} copies   ` +
            `◇ SR ${unique.SR} unique / ${copies.SR} copies   ` +
            `● R ${unique.R} unique / ${copies.R} copies   ` +
            `○ N ${unique.N} unique / ${copies.N} copies`;
    }

    switchTab(key) {
        this.activeTab = key;
        const LABELS = { UR: '◆ UR', SR: '◇ SR', R: '● R', N: '○ N' };
        for (const [k, { btn, color }] of Object.entries(this.tabEls)) {
            const active = k === key;
            const count = this.cards.filter(c => (c.rarity in this.tabEls ? c.rarity : 'N') === k).length;
            btn.textContent = count > 0 ? `${LABELS[k]} · ${count}` : LABELS[k];
            btn.style.color = active ? color : '#6b7280';
            btn.style.borderBottom = active ? `3px solid ${color}` : '3px solid transparent';
            btn.style.background = active ? color + '18' : 'none';
        }
        this.grid.empty();
        const cards = this.cards
            .filter(c => (c.rarity in this.tabEls ? c.rarity : 'N') === key)
            .sort((a, b) => a.name.localeCompare(b.name));
        if (cards.length === 0) {
            const empty = this.grid.createEl('div');
            empty.style.cssText = `
                color: #4b5563; font-family: monospace; font-size: 0.85em;
                grid-column: 1 / -1; padding: 30px 0; text-align: center;
            `;
            empty.textContent = 'No cards in this rarity yet.';
        } else {
            for (const card of cards) this.renderCard(card, this.grid);
        }
    }

    renderCard(card, container) {
        const rarityColor = RARITY_COLOR[card.rarity] || '#94a3b8';
        const wrap = container.createEl('div');
        wrap.style.cssText = `
            display: flex; flex-direction: column; align-items: center;
            background: #111827; border-radius: 8px; padding: 8px 5px 9px;
            border: 1.5px solid ${rarityColor}77; cursor: pointer;
            transition: transform .15s; position: relative;
        `;
        wrap.title = `${card.name}\nClick to add a copy`;

        const badge = wrap.createEl('div');
        badge.textContent = `×${card.count}`;
        badge.style.cssText = `
            position: absolute; top: 4px; left: 4px; background: #374151; color: #e2e8f0;
            font-size: 0.6em; padding: 1px 5px; border-radius: 8px; font-family: monospace; font-weight: bold;
        `;

        // Remove button (top-right) — removes ONE copy of this card, same
        // decrement-not-wipe behavior as the Deck Builder's ✕.
        const removeBtn = wrap.createEl('div');
        removeBtn.textContent = '✕';
        removeBtn.title = `Remove 1 copy of "${card.name}"`;
        removeBtn.style.cssText = `
            position: absolute; top: 3px; right: 3px; width: 15px; height: 15px;
            border-radius: 50%; background: #1f2937; color: #6b7280; font-size: 0.6em;
            display: flex; align-items: center; justify-content: center; opacity: 0.35;
            transition: opacity .12s, background .12s, color .12s; cursor: pointer;
        `;
        wrap.onmouseenter = () => { wrap.style.transform = 'scale(1.06)'; removeBtn.style.opacity = '0.85'; };
        wrap.onmouseleave = () => { wrap.style.transform = 'scale(1)'; removeBtn.style.opacity = '0.35'; };
        removeBtn.onmouseenter = () => { removeBtn.style.background = '#7f1d1d'; removeBtn.style.color = '#fca5a5'; };
        removeBtn.onmouseleave = () => { removeBtn.style.background = '#1f2937'; removeBtn.style.color = '#6b7280'; };

        const img = wrap.createEl('img');
        img.src = card.image;
        img.style.cssText = 'width: 82px; border-radius: 4px; display: block; pointer-events: none;';

        const nameEl = wrap.createEl('div');
        nameEl.textContent = card.name.length > 17 ? card.name.slice(0, 15) + '…' : card.name;
        nameEl.style.cssText = `
            font-size: 0.6em; text-align: center; color: #cbd5e1; margin-top: 5px;
            line-height: 1.3; max-width: 100px; font-family: monospace;
        `;

        wrap.onclick = async () => {
            card.count = (card.count || 0) + 1;
            badge.textContent = `×${card.count}`;
            await this.saveCard(card);
            this.renderStats();
        };
        removeBtn.onclick = async (e) => {
            e.stopPropagation();
            await this.removeCard(card);
        };
    }

    async saveCard(card) {
        const content = await this.plugin.readCollection();
        if (content === null) {
            this.setStatus(`⚠️ No collection note at "${this.plugin.settings.collectionNotePath}" — create it via Settings first.`);
            return;
        }
        const updated = upsertCollectionCard(content, card.name, card.rarity || 'N', card.count);
        const success = await this.plugin.writeCollection(updated);
        this.setStatus(success
            ? `💾 "${card.name}" ×${card.count} saved to collection.`
            : `❌ Failed to save "${card.name}".`);
    }

    async removeCard(card) {
        const content = await this.plugin.readCollection();
        if (content === null) return;
        const { content: updated, removed, newCount } = decrementCollectionCard(content, card.name);
        const success = await this.plugin.writeCollection(updated);
        if (!success) { this.setStatus(`❌ Failed to update "${card.name}".`); return; }
        if (removed) {
            this.cards = this.cards.filter(c => c !== card);
            this.setStatus(`🗑️ "${card.name}" removed from collection.`);
        } else {
            card.count = newCount;
            this.setStatus(`➖ "${card.name}" now ×${newCount}.`);
        }
        this.switchTab(this.activeTab);
        this.renderStats();
    }

    async loadCollection() {
        const content = await this.plugin.readCollection();
        if (content === null) {
            this.setStatus(`⚠️ No collection note found at "${this.plugin.settings.collectionNotePath}". Create one via Settings → 📦 Create Collection Note.`);
            this.cards = [];
            this.switchTab(this.activeTab);
            this.renderStats();
            return;
        }
        const entries = parseCollectionFromMarkdown(content);
        if (entries.size === 0) {
            this.setStatus('No cards in your collection note yet — add some above.');
            this.cards = [];
            this.switchTab(this.activeTab);
            this.renderStats();
            return;
        }
        this.cards = [];
        this.setStatus(`Fetching ${entries.size} unique cards…`);
        let loaded = 0;
        for (const entry of entries.values()) {
            const card = await this.plugin.fetchCard(entry.name);
            if (card) {
                card.count = entry.count;
                this.cards.push(card);
            }
            loaded++;
            this.setStatus(`Loading ${loaded}/${entries.size}: ${entry.name}`);
            await new Promise(r => setTimeout(r, 110));
        }
        this.setStatus(`✅ ${this.cards.length} cards loaded.`);
        this.switchTab(this.activeTab);
        this.renderStats();
    }

    onClose() { this.contentEl.empty(); }
}

class YugiohSettingTab extends PluginSettingTab {
    constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'Yu-Gi-Oh! Master Duel Deck Builder' });
        containerEl.createEl('p', {
            text: 'Open your deck checklist note in Obsidian, then run the command "🐉 Open Deck Builder". The plugin will automatically read and write to whichever note is currently active.'
        });

        containerEl.createEl('h3', { text: '📄 Deck Template' });
        containerEl.createEl('p', {
            text: 'Creates a blank Master Duel deck template in your Templates folder (creates the folder if it does not exist). You can then duplicate this note for each new deck you build.'
        });

        new Setting(containerEl)
            .setName('Create / update deck template')
            .setDesc('Writes "Master Duel Deck Template.md" into your Templates folder and opens it. Safe to run again — it will overwrite with the latest blank template.')
            .addButton(btn => btn
                .setButtonText('📄 Create Template')
                .setCta()
                .onClick(() => this.plugin.createDeckTemplate())
            );

        containerEl.createEl('h3', { text: '📦 Collection' });
        containerEl.createEl('p', {
            text: 'Tracks every card you own, independent of any single deck. Used by the Collection Manager and the Deck Builder\'s "have vs need" badges and 📦 Craft List.'
        });
        new Setting(containerEl)
            .setName('Collection note path')
            .setDesc('Vault path to the note that tracks owned cards (e.g. "Yu-Gi-Oh Collection.md").')
            .addText(text => text
                .setValue(this.plugin.settings.collectionNotePath)
                .onChange(async (value) => {
                    this.plugin.settings.collectionNotePath = value.trim() || DEFAULT_SETTINGS.collectionNotePath;
                    await this.plugin.saveSettings();
                })
            );
        new Setting(containerEl)
            .setName('Create collection note')
            .setDesc('Creates a blank collection note at the path above if it doesn\'t exist yet, and opens it.')
            .addButton(btn => btn
                .setButtonText('📦 Create Collection Note')
                .setCta()
                .onClick(() => this.plugin.createCollectionNote())
            );
        new Setting(containerEl)
            .setName('Open collection note')
            .setDesc('Opens the existing collection note directly, for manual editing (bulk-pasting a list, fixing a typo, etc.) instead of the Collection Manager UI.')
            .addButton(btn => btn
                .setButtonText('📂 Open Note')
                .onClick(() => this.plugin.openCollectionNote())
            );

        containerEl.createEl('h3', { text: '🚫 Master Duel Banlist' });
        const meta = this.plugin.banlistMeta;
        const ageDays = this.plugin.getBanlistAgeDays();
        containerEl.createEl('p', {
            text: meta?.asOf
                ? `Current snapshot dated ${meta.asOf}${ageDays !== null ? ` (${ageDays} days old)` : ''}. Auto-updates in the background on every launch from the YAML Yugi limit-regulation project (community-maintained, updated daily).`
                : 'No banlist data loaded yet.'
        });
        new Setting(containerEl)
            .setName('Check for banlist update now')
            .setDesc('Fetches the latest Master Duel limit regulation and reloads it immediately, without waiting for the next launch.')
            .addButton(btn => btn
                .setButtonText('🔄 Check Now')
                .setCta()
                .onClick(async () => {
                    btn.setDisabled(true);
                    await this.plugin.updateBanlistFromSource(true);
                    btn.setDisabled(false);
                    this.display();
                })
            );
    }
}

// Advanced Search — filter by type/attribute/level/archetype/rarity instead
// of the toolbar's exact-name lookup. Opened from the Deck Builder toolbar;
// clicking a result tile adds it to whichever deck tab was active when the
// search modal was opened (via deckUI.addFetchedCardToDeck), and the modal
// stays open so several cards can be added from one search.
class CardSearchUI extends Modal {
    constructor(app, plugin, deckUI) {
        super(app);
        this.plugin = plugin;
        this.deckUI = deckUI;
        this.loading = false;
    }

    onOpen() {
        this.modalEl.style.width = '760px';
        this.modalEl.style.maxWidth = '95vw';
        this.modalEl.style.maxHeight = '88vh';

        const { contentEl } = this;
        contentEl.style.cssText = `
            background: #0d0f1a; color: #e2e8f0; font-family: 'Georgia', serif;
            padding: 0; overflow: hidden; display: flex; flex-direction: column; height: 78vh;
        `;

        const header = contentEl.createEl('div');
        header.style.cssText = `
            background: linear-gradient(135deg, #1a0a2e 0%, #16213e 50%, #0f3460 100%);
            padding: 16px 24px 12px; border-bottom: 2px solid #8b5cf644; flex-shrink: 0;
        `;
        const title = header.createEl('h1');
        title.textContent = '🔎 Advanced Search';
        title.style.cssText = `
            margin: 0 0 3px; font-size: 1.3em; font-weight: bold;
            background: linear-gradient(90deg, #a78bfa, #f5c3ff);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
        `;
        const sub = header.createEl('p');
        sub.style.cssText = 'margin: 0; font-size: 0.72em; color: #94a3b8; font-family: monospace;';
        sub.textContent = `Adding to: ${this.deckUI?.decks?.[this.deckUI?.activeTab] ? this.deckUI.activeTab : '— switch to a deck tab first —'}`;

        // ── Filter form ─────────────────────────────────────────────────────
        const form = contentEl.createEl('div');
        form.style.cssText = `
            display: flex; gap: 8px; padding: 12px 20px; background: #111827;
            border-bottom: 1px solid #1f2937; flex-shrink: 0; flex-wrap: wrap; align-items: center;
        `;

        const fieldStyle = `
            background: #1f2937; border: 1px solid #374151; border-radius: 6px;
            padding: 7px 10px; color: #e2e8f0; font-size: 0.82em; outline: none;
            font-family: monospace;
        `;

        const nameInput = form.createEl('input');
        nameInput.placeholder = 'Name contains…';
        nameInput.style.cssText = fieldStyle + 'flex: 1.4; min-width: 130px;';

        const typeSelect = form.createEl('select');
        typeSelect.style.cssText = fieldStyle + 'flex: 1; min-width: 110px;';
        [
            ['', 'Any type'], ['Effect Monster', 'Effect Monster'], ['Normal Monster', 'Normal Monster'],
            ['Ritual Monster', 'Ritual Monster'], ['Fusion Monster', 'Fusion Monster'],
            ['Synchro Monster', 'Synchro Monster'], ['XYZ Monster', 'Xyz Monster'],
            ['Link Monster', 'Link Monster'], ['Pendulum Effect Monster', 'Pendulum Effect Monster'],
            ['Spell Card', 'Spell Card'], ['Trap Card', 'Trap Card'],
        ].forEach(([val, label]) => {
            const opt = typeSelect.createEl('option');
            opt.value = val; opt.textContent = label;
        });

        const attrSelect = form.createEl('select');
        attrSelect.style.cssText = fieldStyle + 'flex: 0.7; min-width: 90px;';
        ['', 'DARK', 'LIGHT', 'EARTH', 'WATER', 'FIRE', 'WIND', 'DIVINE'].forEach(val => {
            const opt = attrSelect.createEl('option');
            opt.value = val; opt.textContent = val || 'Any attribute';
        });

        const levelInput = form.createEl('input');
        levelInput.type = 'number';
        levelInput.min = '0'; levelInput.max = '13';
        levelInput.placeholder = 'Level/Rank';
        levelInput.style.cssText = fieldStyle + 'flex: 0.6; min-width: 80px;';

        const archetypeInput = form.createEl('input');
        archetypeInput.placeholder = 'Archetype…';
        archetypeInput.style.cssText = fieldStyle + 'flex: 1; min-width: 110px;';

        const raritySelect = form.createEl('select');
        raritySelect.style.cssText = fieldStyle + 'flex: 0.6; min-width: 90px;';
        ['', 'UR', 'SR', 'R', 'N'].forEach(val => {
            const opt = raritySelect.createEl('option');
            opt.value = val; opt.textContent = val ? `MD: ${val}` : 'Any rarity';
        });

        const altArtLabel = form.createEl('label');
        altArtLabel.style.cssText = `
            display: flex; align-items: center; gap: 5px; font-size: 0.78em;
            color: #cbd5e1; font-family: monospace; cursor: pointer; white-space: nowrap;
        `;
        const altArtCheckbox = altArtLabel.createEl('input');
        altArtCheckbox.type = 'checkbox';
        altArtLabel.appendText('🎨 Alt art only');

        const searchBtn = form.createEl('button');
        searchBtn.textContent = '🔎 Search';
        searchBtn.style.cssText = `
            background: #8b5cf6; color: #fff; border: none; padding: 7px 14px;
            border-radius: 6px; cursor: pointer; font-weight: bold; font-size: 0.82em;
        `;

        [nameInput, levelInput, archetypeInput].forEach(el => {
            el.addEventListener('keydown', e => { if (e.key === 'Enter') searchBtn.click(); });
        });

        // ── Status + results ────────────────────────────────────────────────
        const statusBar = contentEl.createEl('div');
        statusBar.style.cssText = `
            padding: 5px 22px; font-size: 0.72em; color: #6b7280;
            background: #0d0f1a; flex-shrink: 0; font-family: monospace;
            border-bottom: 1px solid #1f2937;
        `;
        statusBar.textContent = 'Set a filter and hit Search.';

        const grid = contentEl.createEl('div');
        grid.style.cssText = `
            flex: 1; overflow-y: auto; padding: 16px 20px;
            display: grid; grid-template-columns: repeat(auto-fill, minmax(108px, 1fr));
            gap: 10px; align-content: start;
        `;

        searchBtn.onclick = async () => {
            if (this.loading) return;
            const filters = {
                name: nameInput.value, type: typeSelect.value, attribute: attrSelect.value,
                level: levelInput.value, archetype: archetypeInput.value, rarity: raritySelect.value,
                altArtOnly: altArtCheckbox.checked,
            };
            this.loading = true; searchBtn.disabled = true;
            statusBar.textContent = filters.altArtOnly
                ? 'Scanning the full card database for alt arts — this can take a few seconds…'
                : 'Searching…';
            grid.empty();

            const { results, error, capped, totalMatches } = await this.plugin.searchCards(filters);
            this.loading = false; searchBtn.disabled = false;

            if (error) {
                statusBar.textContent = `❌ ${error}`;
                return;
            }
            if (results.length === 0) {
                statusBar.textContent = 'No cards matched those filters.';
                return;
            }
            const countLabel = capped && totalMatches != null
                ? `${results.length} of ${totalMatches} results`
                : `${results.length} result${results.length > 1 ? 's' : ''}`;
            statusBar.textContent = `${countLabel}${filters.altArtOnly ? ' (alt art)' : ' (incl. alt arts)'}${capped ? ' — add a name/type/archetype filter to narrow' : ''} — click a card to add it.`;
            for (const card of results) this.renderResultTile(card, grid);
        };
    }

    renderResultTile(card, container) {
        const rarityColor = RARITY_COLOR[card.rarity] || '#94a3b8';

        const wrap = container.createEl('div');
        wrap.style.cssText = `
            display: flex; flex-direction: column; align-items: center;
            background: #111827; border-radius: 8px; padding: 8px 5px 9px;
            border: 1.5px solid ${rarityColor}77; cursor: pointer;
            transition: transform .15s, border-color .15s;
        `;
        wrap.title = `${card.name}${card.artVariant ? ` (${card.artVariant})` : ''}\n${card.type}\n${card.desc?.slice(0, 140) ?? ''}…\nClick to add`;

        wrap.onmouseenter = () => { wrap.style.transform = 'scale(1.06)'; wrap.style.borderColor = rarityColor; };
        wrap.onmouseleave = () => { wrap.style.transform = 'scale(1)'; wrap.style.borderColor = rarityColor + '77'; };

        const img = wrap.createEl('img');
        img.src = card.image;
        img.style.cssText = 'width: 82px; border-radius: 4px; display: block; pointer-events: none;';

        const nameEl = wrap.createEl('div');
        nameEl.textContent = card.name.length > 17 ? card.name.slice(0, 15) + '…' : card.name;
        nameEl.style.cssText = `
            font-size: 0.6em; text-align: center; color: #cbd5e1;
            margin-top: 5px; line-height: 1.3; max-width: 100px; font-family: monospace;
        `;

        if (card.artVariant) {
            const artEl = wrap.createEl('div');
            artEl.textContent = `🎨 ${card.artVariant}`;
            artEl.style.cssText = 'font-size: 0.56em; color: #c084f5; margin-top: 1px; font-family: monospace;';
        }

        const rarityEl = wrap.createEl('div');
        rarityEl.textContent = RARITY_LABEL[card.rarity] || card.rarity;
        rarityEl.style.cssText = `font-size: 0.58em; font-weight: bold; color: ${rarityColor}; margin-top: 2px; font-family: monospace;`;

        const banStatus = card.ban_md || this.plugin.getBanStatusMD(card.konami_id);
        if (banStatus && banStatus !== 'Unlimited') {
            const banEl = wrap.createEl('div');
            banEl.textContent = `⚠ MD: ${banStatus}`;
            banEl.style.cssText = 'font-size: 0.54em; color: #f87171; margin-top: 2px; font-family: monospace;';
        }

        wrap.onclick = async () => {
            if (!this.deckUI) {
                return new Notice('Open this search from the Deck Builder to add cards.');
            }
            const added = await this.deckUI.addFetchedCardToDeck(card);
            if (added) {
                wrap.style.borderColor = '#4ade80';
                setTimeout(() => { wrap.style.borderColor = rarityColor + '77'; }, 400);
            }
        };
    }
}

// Visual Combo Builder — lets you assemble a combo as a sequence of card
// steps (autocompleted against cards already known to the plugin: deck cards
// + previously-resolved combo cards) instead of hand-typing the arrow-joined
// text. Still saves through DeckUI.saveComboText(), so it produces the exact
// same "- [ ] A → B → C" markdown line the text parser already understands —
// this is a friendlier input method, not a new storage format.
class ComboBuilderUI extends Modal {
    constructor(app, plugin, deckUI, categories, existingCombo = null) {
        super(app);
        this.plugin = plugin;
        this.deckUI = deckUI;
        this.categories = categories || [];
        this.existingCombo = existingCombo;
        this.stepRows = []; // { rowEl, input, dropdown }
    }

    getCandidatePool() {
        const map = new Map();
        for (const c of this.deckUI.allCards || []) {
            if (!map.has(c.name.toLowerCase())) map.set(c.name.toLowerCase(), c);
        }
        for (const c of (this.deckUI.comboCardCache || new Map()).values()) {
            if (!map.has(c.name.toLowerCase())) map.set(c.name.toLowerCase(), c);
        }
        return [...map.values()];
    }

    onOpen() {
        this.pool = this.getCandidatePool();
        this.modalEl.style.width = '640px';
        this.modalEl.style.maxWidth = '95vw';

        const { contentEl } = this;
        contentEl.style.cssText = `
            background: #0d0f1a; color: #e2e8f0; font-family: 'Georgia', serif; padding: 0;
        `;

        const header = contentEl.createEl('div');
        header.style.cssText = `
            background: linear-gradient(135deg, #1a0a2e 0%, #16213e 50%, #0f3460 100%);
            padding: 16px 24px 12px; border-bottom: 2px solid #a78bfa44;
        `;
        const title = header.createEl('h1');
        title.textContent = this.existingCombo ? '✏️ Edit Combo' : '🧩 Visual Combo Builder';
        title.style.cssText = `
            margin: 0 0 3px; font-size: 1.25em; font-weight: bold;
            background: linear-gradient(90deg, #a78bfa, #c4b5fd);
            -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text;
        `;
        const sub = header.createEl('p');
        sub.textContent = this.existingCombo
            ? 'Editing steps only — category stays where this combo already lives in the note.'
            : 'Pick each step from your known cards — art resolves automatically. Unrecognized text still works as a shorthand step.';
        sub.style.cssText = 'margin: 0; font-size: 0.7em; color: #94a3b8; font-family: monospace;';

        const body = contentEl.createEl('div');
        body.style.cssText = 'padding: 16px 24px 20px; max-height: 68vh; overflow-y: auto;';

        // ── Category (hidden when editing — see sub text above) ────────────────
        const catRow = body.createEl('div');
        catRow.style.cssText = `display: ${this.existingCombo ? 'none' : 'flex'}; gap: 8px; margin-bottom: 14px;`;
        const catFieldStyle = `
            background: #1f2937; border: 1px solid #4c1d95; border-radius: 6px;
            padding: 7px 10px; color: #e2e8f0; font-size: 0.82em; outline: none; font-family: monospace;
        `;
        const catSelect = catRow.createEl('select');
        catSelect.style.cssText = catFieldStyle + 'flex: 1;';
        (this.categories.length ? this.categories : ['General']).forEach(cat => {
            const opt = catSelect.createEl('option');
            opt.value = cat; opt.textContent = cat;
        });
        const catCustom = catRow.createEl('input');
        catCustom.placeholder = 'Or new category…';
        catCustom.style.cssText = catFieldStyle + 'flex: 1;';

        // ── Steps ────────────────────────────────────────────────────────────
        const stepsHeading = body.createEl('div');
        stepsHeading.textContent = 'Steps';
        stepsHeading.style.cssText = 'font-family: monospace; font-size: 0.76em; color: #6b7280; margin-bottom: 6px;';

        const stepsWrap = body.createEl('div');
        stepsWrap.style.cssText = 'display: flex; flex-direction: column; gap: 6px; margin-bottom: 10px;';

        const addStepBtn = body.createEl('button');
        addStepBtn.textContent = '+ Add Step';
        addStepBtn.style.cssText = `
            background: #1f2937; color: #a78bfa; border: 1px dashed #4c1d95;
            padding: 6px 12px; border-radius: 6px; cursor: pointer;
            font-size: 0.78em; font-family: monospace; font-weight: bold; margin-bottom: 16px;
        `;
        addStepBtn.onclick = () => { this.addStepRow(stepsWrap); this.updatePreview(); };

        // ── Live preview ─────────────────────────────────────────────────────
        const previewHeading = body.createEl('div');
        previewHeading.textContent = 'Preview';
        previewHeading.style.cssText = 'font-family: monospace; font-size: 0.76em; color: #6b7280; margin-bottom: 6px;';
        this.previewEl = body.createEl('div');
        this.previewEl.style.cssText = `
            display: flex; align-items: center; flex-wrap: wrap; gap: 4px; min-height: 44px;
            background: #111827; border: 1px solid #1f2937; border-radius: 8px; padding: 8px 10px;
            margin-bottom: 18px;
        `;

        // ── Actions ──────────────────────────────────────────────────────────
        const actions = body.createEl('div');
        actions.style.cssText = 'display: flex; gap: 8px; justify-content: flex-end;';
        const cancelBtn = actions.createEl('button', { text: 'Cancel' });
        cancelBtn.style.cssText = `
            background: #374151; color: #e2e8f0; border: none;
            padding: 7px 15px; border-radius: 6px; cursor: pointer; font-size: 0.82em; font-family: monospace;
        `;
        cancelBtn.onclick = () => this.close();

        const saveBtn = actions.createEl('button', { text: this.existingCombo ? '💾 Save Changes' : '💾 Save Combo' });
        saveBtn.style.cssText = `
            background: #7c3aed; color: #fff; border: none;
            padding: 7px 15px; border-radius: 6px; cursor: pointer;
            font-size: 0.82em; font-family: monospace; font-weight: bold;
        `;
        saveBtn.onclick = async () => {
            const steps = this.stepRows.map(r => r.input.value.trim()).filter(Boolean);
            if (steps.length < 2) {
                return new Notice('Add at least 2 steps to form a combo.');
            }
            const text = steps.join(' → ');
            let ok;
            if (this.existingCombo) {
                ok = await this.deckUI.updateComboText(this.existingCombo.rawText, text, this.existingCombo.learned);
            } else {
                const cat = catCustom.value.trim() || catSelect.value;
                ok = await this.deckUI.saveComboText(text, cat, this.categories);
            }
            if (!ok) return;
            this.deckUI.switchTab('combos');
            this.deckUI.setStatus(`✅ Combo ${this.existingCombo ? 'updated' : 'added'}: "${text.slice(0, 50)}"`);
            this.close();
        };

        // Prefill from the existing combo when editing; otherwise start with
        // two empty steps — most combos need at least that many.
        if (this.existingCombo) {
            const existingSteps = this.existingCombo.text.split(/→|->|➜/).map(s => s.trim()).filter(Boolean);
            if (existingSteps.length > 0) {
                existingSteps.forEach(s => {
                    this.addStepRow(stepsWrap);
                    this.stepRows[this.stepRows.length - 1].input.value = s;
                });
            } else {
                this.addStepRow(stepsWrap);
                this.addStepRow(stepsWrap);
            }
        } else {
            this.addStepRow(stepsWrap);
            this.addStepRow(stepsWrap);
        }
        this.updatePreview();
    }

    addStepRow(stepsWrap) {
        const idx = this.stepRows.length;
        const row = stepsWrap.createEl('div');
        row.style.cssText = 'display: flex; gap: 6px; align-items: center; position: relative;';

        const numLabel = row.createEl('span');
        numLabel.textContent = `${idx + 1}.`;
        numLabel.style.cssText = 'font-family: monospace; font-size: 0.8em; color: #6b7280; width: 18px; flex-shrink: 0;';

        const input = row.createEl('input');
        input.placeholder = 'Card name or shorthand step…';
        input.style.cssText = `
            flex: 1; background: #1f2937; border: 1px solid #374151; border-radius: 6px;
            padding: 7px 10px; color: #e2e8f0; font-size: 0.84em; font-family: monospace; outline: none;
        `;
        input.addEventListener('focus', () => input.style.borderColor = '#a78bfa');
        input.addEventListener('blur', () => setTimeout(() => { dropdown.style.display = 'none'; input.style.borderColor = '#374151'; }, 150));

        const removeBtn = row.createEl('button');
        removeBtn.textContent = '✕';
        removeBtn.style.cssText = `
            background: none; border: none; color: #6b7280; cursor: pointer;
            font-size: 0.9em; padding: 4px 6px; flex-shrink: 0;
        `;
        removeBtn.onclick = () => {
            row.remove();
            this.stepRows = this.stepRows.filter(r => r.row !== row);
            this.renumberSteps(stepsWrap);
            this.updatePreview();
        };

        const dropdown = row.createEl('div');
        dropdown.style.cssText = `
            display: none; position: absolute; top: 100%; left: 24px; right: 0; z-index: 10;
            background: #1f2937; border: 1px solid #4c1d95; border-radius: 6px;
            max-height: 160px; overflow-y: auto; margin-top: 2px;
        `;

        input.addEventListener('input', () => {
            const q = input.value.trim().toLowerCase();
            dropdown.empty();
            if (!q) { dropdown.style.display = 'none'; this.updatePreview(); return; }
            const matches = this.pool.filter(c => c.name.toLowerCase().includes(q)).slice(0, 8);
            if (matches.length === 0) { dropdown.style.display = 'none'; this.updatePreview(); return; }
            for (const card of matches) {
                const item = dropdown.createEl('div');
                item.style.cssText = `
                    display: flex; align-items: center; gap: 6px; padding: 5px 8px; cursor: pointer;
                    font-family: monospace; font-size: 0.78em; color: #e2e8f0;
                `;
                item.onmouseenter = () => item.style.background = '#374151';
                item.onmouseleave = () => item.style.background = 'none';
                if (card.image) {
                    const img = item.createEl('img');
                    img.src = card.image;
                    img.style.cssText = 'width: 18px; height: 26px; object-fit: cover; border-radius: 2px; flex-shrink: 0;';
                }
                item.appendChild(document.createTextNode(card.name));
                item.onmousedown = (e) => {
                    e.preventDefault();
                    input.value = card.name;
                    dropdown.style.display = 'none';
                    this.updatePreview();
                };
            }
            dropdown.style.display = 'block';
            this.updatePreview();
        });

        this.stepRows.push({ row, input, dropdown });
    }

    renumberSteps(stepsWrap) {
        [...stepsWrap.children].forEach((row, i) => {
            const label = row.querySelector('span');
            if (label) label.textContent = `${i + 1}.`;
        });
    }

    updatePreview() {
        this.previewEl.empty();
        const steps = this.stepRows.map(r => r.input.value.trim()).filter(Boolean);
        if (steps.length === 0) {
            const hint = this.previewEl.createEl('span');
            hint.textContent = 'Fill in steps above to see a preview…';
            hint.style.cssText = 'color: #4b5563; font-family: monospace; font-size: 0.78em;';
            return;
        }
        steps.forEach((step, i) => {
            const match = this.pool.find(c => c.name.toLowerCase() === step.toLowerCase());
            if (match) {
                const chip = this.previewEl.createEl('span');
                chip.style.cssText = `
                    display: inline-flex; align-items: center; gap: 4px;
                    background: #1e1b4b; border: 1px solid #4c1d95; border-radius: 4px;
                    padding: 2px 6px 2px 2px; font-size: 0.8em; color: #c4b5fd; font-family: monospace;
                `;
                if (match.image) {
                    const img = chip.createEl('img');
                    img.src = match.image;
                    img.style.cssText = 'width: 20px; height: 29px; object-fit: cover; border-radius: 2px;';
                }
                chip.appendChild(document.createTextNode(match.name));
            } else {
                const chip = this.previewEl.createEl('span');
                chip.textContent = step;
                chip.style.cssText = `
                    font-size: 0.8em; color: #94a3b8; font-family: monospace;
                    background: #1f2937; border: 1px dashed #374151; border-radius: 4px; padding: 2px 6px;
                `;
            }
            if (i < steps.length - 1) {
                const arrow = this.previewEl.createEl('span');
                arrow.textContent = '→';
                arrow.style.cssText = 'color: #a78bfa; font-weight: bold; font-size: 0.9em;';
            }
        });
    }
}

module.exports = YugiohPlugin;