const { App, Plugin, PluginSettingTab, Setting, Notice, Modal, TFile } = require('obsidian');

const HAND_TRAPS = [
    'Ash Blossom & Joyous Spring', 'Maxx "C"', 'Effect Veiler',
    'Nibiru, the Primal Being', 'Droll & Lock Bird', 'Ghost Ogre & Snow Rabbit'
];

const MD_RARITY_DB = {
    'Ash Blossom & Joyous Spring': 'UR', 'Maxx "C"': 'UR', 'Effect Veiler': 'SR',
    'Nibiru, the Primal Being': 'UR', 'Elemental HERO Stratos': 'SR',
    'Destiny HERO Malicious': 'SR', 'Chamber Dragonmaid': 'UR',
    'Parlor Dragonmaid': 'SR', 'Dragonmaid Changeover': 'R',
    'Dragonmaid Hospitality': 'SR', 'Dragonmaid Tidying': 'SR',
    'Dragonmaid Sheou': 'UR', 'House Dragonmaid': 'SR', 'Dragonmaid Strahl': 'UR',
    'Infinite Impermanence': 'UR', 'Called by the Grave': 'UR',
    'That Grass Looks Greener': 'UR', 'Chaos Dragon Levianeer': 'UR',
    'Bystial Magnamhut': 'UR', 'Bystial Druiswurm': 'SR',
    'Accesscode Talker': 'UR', 'Mirrorjade the Iceblade Dragon': 'UR',
    'Bystial Dis Pater': 'UR', 'A Hero Lives': 'UR', 'Book of Moon': 'R',
    'Boot Sector Launch': 'SR', 'Chaos Space': 'SR',
    'Compulsory Evacuation Device': 'R'
};

const DEFAULT_SETTINGS = {};

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
    let currentDepth = 0;
    for (let i = 0; i < lines.length; i++) {
        const hm = lines[i].match(/^(#{1,6})\s+.*/);
        if (hm) {
            const depth = hm[1].length;
            if (currentDepth === 0 || depth <= currentDepth) {
                currentType = explicitTypeGroup(lines[i]);
                currentDepth = depth;
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

        const m = lines[i].match(CARD_LINE_RE);
        if (!m) continue;

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
    const countPrefix = card.count && card.count > 1 ? `${card.count}x ` : '';
    const newLine = `- [${card.owned ? 'x' : ' '}] ${countPrefix}${card.name} ×1 [${rarity}]`;

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
        if (typeGroups[i] === cardType && CARD_LINE_RE.test(lines[i])) lastIdxInType = i;
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
        if (groups[i] === groupKey && CARD_LINE_RE.test(lines[i])) lastIdxInGroup = i;
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
                `https://db.ygoprodeck.com/api/v7/cardinfo.php?name=${encodeURIComponent(resolvedName)}`
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
                rarity: MD_RARITY_DB[c.name] || this.getRarity(c),
                frameType: c.frameType
            };
        } catch (err) {
            console.error('[YugiohPlugin] fetchCard error:', err);
            return null;
        }
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
                `https://db.ygoprodeck.com/api/v7/cardinfo.php?fname=${encodeURIComponent(cleaned)}`
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
                    rarity: MD_RARITY_DB[c.name] || this.getRarity(c),
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

class DeckUI extends Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.decks = { main60: [], main40: [], extra: [] };
        this.allCards = [];
        this.combos = [];
        this.comboCardCache = new Map(); // name.toLowerCase() → card object
        this.activeTab = 'main60';
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
        const applyTplBtn = this.makeBtn(searchRow, '🗋 Apply Template', '#1f2937', '#f87171');
        applyTplBtn.title = 'Overwrite the current note with the blank deck template';

        // ── Tab bar ─────────────────────────────────────────────────────────
        const tabBar = contentEl.createEl('div');
        tabBar.style.cssText = `
            display: flex; gap: 0; flex-shrink: 0;
            background: #0d0f1a; border-bottom: 2px solid #1f2937;
        `;

        const TABS = [
            { key: 'main60', label: '🟦 Main Deck (60)', color: '#60a5fa' },
            { key: 'main40', label: '🟢 40-Card Variant', color: '#4ade80' },
            { key: 'extra', label: '🟥 Extra Deck', color: '#f87171' },
            { key: 'combos', label: '🧠 Combos', color: '#a78bfa' },
        ];
        this.tabEls = {};
        for (const tab of TABS) {
            const btn = tabBar.createEl('button');
            btn.textContent = tab.label;
            btn.dataset.tabKey = tab.key;
            btn.style.cssText = `
                background: none; border: none; border-bottom: 3px solid transparent;
                padding: 9px 18px; color: #6b7280; cursor: pointer;
                font-size: 0.82em; font-weight: bold; font-family: monospace;
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

            const card = await this.plugin.fetchCard(name);
            this.loading = false; addBtn.disabled = false;

            if (!card) {
                this.setStatus(`❌ Not found: "${name}"`);
                return new Notice(`Card not found: "${name}"`);
            }

            card.owned = true;
            card.deckGroup = this.activeTab;
            this.decks[this.activeTab].push(card);
            this.allCards.push(card);
            this.renderCard(card, this.grid);
            this.setStatus(`✅ Added "${card.name}" [${card.rarity}] to ${this.activeTab} — saving…`);
            input.value = '';
            await this.saveCardToTemplate(card);
        };

        loadBtn.onclick = () => this.loadFromTemplate();
        statsBtn.onclick = () => this.showStats();
        applyTplBtn.onclick = () => this.confirmApplyTemplate();

        // Auto-load on open
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
            // skip fuzzy-searching these to cut down noisy, useless API calls.
            const STOPWORDS = new Set([
                'mill', 'draw', 'dump', 'loop', 'setup', 'route', 'line', 'board',
                'break', 'up', 'negate', 'summon', 'timing', 'pop', 'extender',
                'the', 'and', 'of', 'in', 'to', 'for', 'on', 'at', 'as', 'or',
            ]);
            for (const part of parts) {
                stepSet.add(part);
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
                        if (sub.length >= 3) stepSet.add(sub);
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
            const cat = (catInput.value.trim() || categories[0] || 'General');
            const newLine = `- [ ] ${text}`;

            const fileContent = await this.plugin.readTemplate();
            if (!fileContent) return new Notice('No active file to save to.');

            // Try to append under a matching heading, or the COMBO section, or end of file
            let updated = fileContent;
            const catHeadingRe = new RegExp(`(^#{1,6}[^\\n]*${cat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*)`, 'im');
            const comboHeadingRe = /^(#{1,6}[^\n]*\bcombo\b[^\n]*)/im;

            if (catHeadingRe.test(updated)) {
                // Insert after the matching category heading's last item
                updated = updated.replace(catHeadingRe, (m) => `${m}\n${newLine}`);
            } else if (comboHeadingRe.test(updated)) {
                // Insert at end of the first COMBO section
                updated = updated.replace(comboHeadingRe, (m) => `${m}\n${newLine}`);
            } else {
                // Append a new combo section at end
                updated += `\n\n## 🧠 COMBO CHECKLIST — ${cat}\n${newLine}\n`;
            }

            await this.plugin.writeTemplate(updated);
            this.combos = parseCombosFromMarkdown(updated);
            newComboInput.value = '';
            addForm.style.display = 'none';
            container.empty();
            this.renderCombos(container);
            this.switchTab('combos');
            this.setStatus(`✅ Combo added: "${text.slice(0, 50)}"`);
        };
        newComboInput.addEventListener('keydown', e => { if (e.key === 'Enter') saveComboBtn.click(); });

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

        // Ban status
        if (card.ban_tcg && card.ban_tcg !== 'Unlimited') {
            const banEl = wrap.createEl('div');
            banEl.textContent = `⚠ ${card.ban_tcg}`;
            banEl.style.cssText = 'font-size: 0.54em; color: #f87171; margin-top: 2px; font-family: monospace;';
        }

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

        // Only treat it as "already there" if it's an actual card entry in this
        // same deck section — not just any mention of the name anywhere in the
        // note (e.g. inside a combo line or the budget checklist).
        const target = card.name.toLowerCase();
        const already = parseCardsFromMarkdown(content).some(
            e => e.deckGroup === card.deckGroup && e.name.toLowerCase() === target
        );
        if (already) {
            this.setStatus(`ℹ️ "${card.name}" already in ${card.deckGroup}.`);
            return;
        }

        const updated = appendCardToSection(content, card);
        const success = await this.plugin.writeTemplate(updated);
        if (!success) {
            this.setStatus(`❌ Failed to save "${card.name}" — no active file found.`);
            return;
        }
        this.setStatus(`💾 "${card.name}" appended to template.`);
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
    }
}

module.exports = YugiohPlugin;