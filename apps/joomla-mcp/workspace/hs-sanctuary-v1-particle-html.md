# Holy Spirit Sanctuary — Variation 1 Particle HTML Map
**Site:** hs-fairfield.solutiosoftware.com | **Outline:** #Home (id: 75)
**Source:** Holy Spirit Church - Sanctuary (standalone).html — Variation 1

---

## Design Overview

Warm cream/parchment palette. Key CSS vars from the design:
- `--brand: #8a6a35` (warm golden brown)
- `--gold: #c9a85f`
- `--ink: #1f1a13` / `--ink-2: #3b342a`
- `--cream: #faf6ef` / `--paper: #ffffff`
- `--line: #e6dcc9`
- Headings: `'Cormorant Garamond'` (italic serif)
- Body: `'Inter'` / system-ui

---

## SECTION-BY-SECTION PARTICLE HTML

---

### 1. `custom-4575` — Contact Information (Top bar)

**Current:** location + phone only
**New:** left (location + phone) + right (social icons + search)

```html
<div class="v1-util-inner">
  <div class="v1-util-left">
    <span>Fairfield, California</span>
    <span class="v1-util-sep"></span>
    <a href="tel:7074253138">707-425-3138</a>
  </div>
  <div class="v1-util-right">
    <a href="https://www.facebook.com/HolySpiritFairfield/" aria-label="Facebook" class="v1-ic-link" target="_blank" rel="noopener">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M14 7h3V3h-3a4 4 0 0 0-4 4v3H7v4h3v8h4v-8h3l1-4h-4V7z"></path></svg>
    </a>
    <a href="https://www.instagram.com/holyspiritfairfield/" aria-label="Instagram" class="v1-ic-link" target="_blank" rel="noopener">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="4"></rect><circle cx="12" cy="12" r="4"></circle><circle cx="17.5" cy="6.5" r="1" fill="currentColor"></circle></svg>
    </a>
  </div>
</div>
```

**Block class to add:** `v1-util`

---

### 2. Hero Section — Swiper + Mass Times

**Layout note:** The Variation 1 design places the Mass Schedule card as a *floating overlay* positioned over the right side of the hero, rather than a 33% side column. Two approaches:

**Option A (recommended — CSS only):** Keep the 67%/33% grid but use absolute positioning CSS on the mass times block to float it over the swiper edge. Add block class `v1-mass-panel` to `block-5057`.

**Option B:** Collapse mass times block to 0% width and inject the mass times HTML directly into a Custom HTML particle inside the Slideshow section.

**Mass Times article (55) content** — update to match the `v1-mass` card structure:

```html
<div class="v1-mass-card">
  <h3>Mass Schedule</h3>
  <div class="v1-mass-sub">— Weekly Liturgy —</div>

  <div class="v1-mass-group">
    <div class="v1-mass-group-label">Weekends</div>
    <div class="v1-mass-row"><span class="v1-mass-day">Saturday</span><span class="v1-mass-time">5:00 pm <em>English</em></span></div>
    <div class="v1-mass-row"><span class="v1-mass-day"></span><span class="v1-mass-time">7:00 pm <em>Spanish</em></span></div>
    <div class="v1-mass-row"><span class="v1-mass-day">Sunday</span><span class="v1-mass-time">7:30, 9:00, 10:30 am, 12:00 pm <em>Eng.</em></span></div>
    <div class="v1-mass-row"><span class="v1-mass-day"></span><span class="v1-mass-time">6:00 am, 2:00 pm <em>Spanish</em></span></div>
  </div>

  <div class="v1-mass-group">
    <div class="v1-mass-group-label">Weekdays</div>
    <div class="v1-mass-row"><span class="v1-mass-day">Mon – Fri</span><span class="v1-mass-time">7:00 &amp; 9:00 am <em>English</em></span></div>
    <div class="v1-mass-row"><span class="v1-mass-day">Tue &amp; Fri</span><span class="v1-mass-time">7:00 pm <em>Spanish</em></span></div>
    <div class="v1-mass-row"><span class="v1-mass-day">Saturday</span><span class="v1-mass-time">9:00 am <em>English</em></span></div>
  </div>
</div>
```

---

### 3. `blockcontent-5975` — Standard Quicklinks (Header section)

**Current:** 5 items — Forms, Give Online, Calendar, Bulletin, Holy Spirit School
**Design:** 4 items — I'm New, Bulletin, Give Online, Faith Formation

**Option A:** Reconfigure the blockcontent particle data (add/reorder items, change icons).
**Option B:** Convert to a `custom` HTML particle:

```html
<div class="v1-quick-inner">
  <a href="/new-to-parish">
    <div class="v1-quick-icon">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><path d="M12 2 L12 22 M2 12 L22 12"></path></svg>
    </div>
    <div>
      <div class="v1-quick-label">I'm New</div>
      <div class="v1-quick-sub">Start Here</div>
    </div>
  </a>
  <a href="/about-us/bulletin">
    <div class="v1-quick-icon">
      <svg width="18" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="3" width="16" height="18"></rect><line x1="8" y1="8" x2="16" y2="8"></line><line x1="8" y1="12" x2="16" y2="12"></line><line x1="8" y1="16" x2="13" y2="16"></line></svg>
    </div>
    <div>
      <div class="v1-quick-label">Bulletin</div>
      <div class="v1-quick-sub">This Week</div>
    </div>
  </a>
  <a href="https://giving.parishsoft.com/App/Giving/hsc" target="_blank" rel="noopener">
    <div class="v1-quick-icon">
      <svg width="22" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 21 C6 17 2 13 2 8.5 C2 5.5 4.5 3 7.5 3 C9.5 3 11 4 12 5.5 C13 4 14.5 3 16.5 3 C19.5 3 22 5.5 22 8.5 C22 13 18 17 12 21Z"></path></svg>
    </div>
    <div>
      <div class="v1-quick-label">Give Online</div>
      <div class="v1-quick-sub">Donate</div>
    </div>
  </a>
  <a href="/faith-formation">
    <div class="v1-quick-icon">
      <svg width="22" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 3 L4 8 L4 20 L12 16 L20 20 L20 8 Z" opacity="0.8"></path></svg>
    </div>
    <div>
      <div class="v1-quick-label">Faith Formation</div>
      <div class="v1-quick-sub">Grow with us</div>
    </div>
  </a>
</div>
```

**Block class:** `v1-quick`

---

### 4. `custom-9454` — Headlines Title (Mainbar section)

**Current:** `<h2>Current News & Events</h2>`
**New:**

```html
<div class="v1-news-head">
  <div class="v1-news-lead">
    <div class="v1-eyebrow">— Current News &amp; Events —</div>
    <h2 class="v1-section-title">Latest from the Parish</h2>
  </div>
  <a href="/news" class="v1-all-link">View All News →</a>
</div>
```

---

### 5. `contentarray-9256` — Current News & Events

No HTML change needed — this pulls 3 articles from category 8. The **block class** on `block-9063` should be updated to `v1-news-grid j-news` to apply the design's 1-featured + 2-side-card grid layout via CSS.

The design's grid uses:
- First article → `v1-news-feature` (large, full image)
- Articles 2–3 → `v1-news-card` (thumbnail + text side by side)

This would be driven by CSS targeting `:nth-child` within the contentarray output, or by updating the contentarray's display template.

---

### 6. `custom-9782` — Calendar / Upcoming Events (Expanded section, 50%)

**Current:** empty
**New:**

```html
<div class="v1-events">
  <div class="v1-col-head"><span class="v1-eyebrow">— On the Calendar —</span></div>
  <h2>Upcoming Events</h2>

  <div class="v1-event-item">
    <div class="v1-event-date">
      <div class="v1-event-m">Jun</div>
      <div class="v1-event-d">10</div>
    </div>
    <div class="v1-event-info">
      <div class="v1-event-feast">Feast of St. Ephrem</div>
      <div class="v1-event-time">All Day · Memorial</div>
    </div>
  </div>

  <div class="v1-event-item">
    <div class="v1-event-date">
      <div class="v1-event-m">Jun</div>
      <div class="v1-event-d">13</div>
    </div>
    <div class="v1-event-info">
      <div class="v1-event-feast">St. Anthony of Padua</div>
      <div class="v1-event-time">All Day · Memorial</div>
    </div>
  </div>

  <div class="v1-event-item">
    <div class="v1-event-date">
      <div class="v1-event-m">Jun</div>
      <div class="v1-event-d">21</div>
    </div>
    <div class="v1-event-info">
      <div class="v1-event-feast">St. Aloysius Gonzaga</div>
      <div class="v1-event-time">All Day · Memorial</div>
    </div>
  </div>

  <a href="/about-us/calendar" class="v1-all-btn">View All Events →</a>
</div>
```

**Note:** Placeholder feast days above — replace with live calendar widget or RokMini Events output.

---

### 7. `custom-2954` — Daily Readings (Expanded section, 50%)

**Current:** empty
**New:**

```html
<div class="v1-readings">
  <div class="v1-col-head"><span class="v1-eyebrow">— USCCB —</span></div>
  <h2>Daily Readings</h2>

  <div class="v1-read-item">
    <div class="v1-day-tag">Today</div>
    <div class="v1-feast-name"><!-- Populated by USCCB widget or iframe --></div>
  </div>

  <!-- USCCB Daily Readings Widget embed -->
  <div class="v1-readings-widget">
    <iframe
      src="https://bible.usccb.org/readings/calendar/widget"
      title="USCCB Daily Readings"
      style="width:100%;border:none;min-height:280px;"
      loading="lazy">
    </iframe>
  </div>

  <a href="https://bible.usccb.org/daily-bible-reading" class="v1-all-btn" target="_blank" rel="noopener">Read Today's Readings →</a>
</div>
```

**Note:** The USCCB does not publish a stable iframe embed URL. Best practice is a JavaScript fetch from `https://bible.usccb.org/api/readings/` or display static content updated periodically.

---

### 8. `custom-9368` — Annual Appeal (Extension section)

**Current:** 3-column layout with `.j-catholic-appeal` / `.appeal-grid`
**New (Variation 1 design):**

```html
<section class="v1-appeal">
  <div class="g-container">

    <div class="v1-appeal-head">
      <span class="v1-eyebrow">— Diocese of Sacramento —</span>
      <h2>2026 Annual Catholic Appeal</h2>
    </div>

    <div class="v1-appeal-grid">

      <!-- Column 1: Brochure -->
      <div class="v1-appeal-brochure-col">
        <div class="v1-appeal-brochure">
          <img src="/images/template/cover-page.png" alt="2026 Annual Catholic Appeal Brochure">
        </div>
        <div class="v1-donate-row">
          <a href="https://www.scd.org/catholic-foundation/donate-annual-catholic-appeal" class="v1-btn-solid">Donate</a>
          <a href="https://www.scd.org/catholic-foundation/donacion" class="v1-btn-solid">Donar</a>
        </div>
        <a href="https://www.scd.org/sites/default/files/2026-02/2026-Annual-Catholic-Appeal-Brochure-121725F.pdf" class="v1-btn-out" target="_blank" rel="noopener">Read the Brochure</a>
      </div>

      <!-- Column 2: English -->
      <div class="v1-appeal-lang-col">
        <div class="v1-lang-tag">Annual Catholic Appeal 2026</div>
        <div class="v1-appeal-video">
          <iframe src="https://www.youtube.com/embed/Y7AoY9otYBI" title="Annual Catholic Appeal 2026" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
        </div>
        <p>Together we can become intertwined into the fabric of God's safety net, providing companionship and hope to our brothers and sisters on the margins. Your generosity allows 18 Catholic charities throughout the diocese to reliably ensure that vital services are available to support struggling families and individuals who feel abandoned. Funds also go to tuition assistance that allows students in low-income communities to attend Catholic Schools and provides seminarians in formation a respite from financial worry. 25% goes back to your parish for its own charitable outreach.</p>
      </div>

      <!-- Column 3: Spanish -->
      <div class="v1-appeal-lang-col">
        <div class="v1-lang-tag">El Llamada Católica Anual del 2026</div>
        <div class="v1-appeal-video">
          <iframe src="https://www.youtube.com/embed/I8RpU-1p6MI" title="El Llamada Católica Anual del 2026" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>
        </div>
        <p>Juntos podemos convertirnos en el tejido de una red de amparo divino, proporcionando acompañamiento y esperanza a nuestros hermanos y hermanas marginados. Su generosidad permite que dieciocho organizaciones católicas en toda la diócesis tengan a su disponibilidad los recursos vitales para ayudar a familias y personas que se sienten desamparadas. Los fondos también asisten con la matrícula escolar, lo que permite a estudiantes de comunidades de bajos ingresos ir a escuelas católicas. Brinda a los seminaristas en formación alivio de las preocupaciones financieras.</p>
      </div>

    </div>
  </div>
</section>
```

---

## CSS NEEDED

All `.v1-*` classes above require a new CSS file. Key rules needed (to add via FTP → Gantry Page Settings):

```css
/* Utility bar */
.v1-util { background: #1f1a13; color: #d9cfb9; font-size: 12px; letter-spacing: 0.06em; }
.v1-util-inner { padding: 10px 48px; display: flex; justify-content: space-between; align-items: center; }
.v1-util-left, .v1-util-right { display: flex; gap: 18px; align-items: center; }
.v1-util-sep { width: 1px; height: 12px; background: #4b4232; }
.v1-ic-link { width: 26px; height: 26px; display: inline-flex; align-items: center; justify-content: center; border: 1px solid #3a3322; border-radius: 50%; transition: all 0.15s; }
.v1-ic-link:hover { color: #c9a85f; border-color: #c9a85f; }

/* Mass times card */
.v1-mass-card { background: #fff; padding: 36px 32px; border-top: 4px solid #8a6a35; box-shadow: 0 30px 60px -30px rgba(40,28,10,0.32); }
.v1-mass-card h3 { font-family: 'Cormorant Garamond', Georgia, serif; font-style: italic; font-size: 28px; text-align: center; margin: 0 0 4px; }
.v1-mass-sub { text-align: center; font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; color: #9a9388; margin-bottom: 20px; }
.v1-mass-group { border-top: 1px solid #e6dcc9; padding: 14px 0; }
.v1-mass-group-label { font-size: 11px; font-weight: 700; letter-spacing: 0.2em; text-transform: uppercase; color: #8a6a35; margin-bottom: 10px; }
.v1-mass-row { display: flex; gap: 10px; margin-bottom: 6px; font-size: 13.5px; }
.v1-mass-day { font-weight: 600; min-width: 90px; }
.v1-mass-time em { font-size: 11.5px; font-style: italic; color: #9a9388; }

/* Quick actions ribbon */
.v1-quick { background: #faf6ef; border-bottom: 1px solid #e6dcc9; }
.v1-quick-inner { max-width: 1280px; margin: 0 auto; display: grid; grid-template-columns: repeat(4, 1fr); }
.v1-quick a { padding: 28px 24px; display: flex; align-items: center; gap: 16px; border-right: 1px solid #e6dcc9; transition: background 0.15s; }
.v1-quick a:last-child { border-right: 0; }
.v1-quick a:hover { background: #f3ecdf; }
.v1-quick-icon { width: 42px; height: 42px; border-radius: 50%; background: #8a6a35; color: white; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
.v1-quick-label { font-family: 'Cormorant Garamond', Georgia, serif; font-style: italic; font-size: 22px; color: #1f1a13; }
.v1-quick-sub { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: #9a9388; margin-top: 2px; }

/* News section head */
.v1-news-head { display: flex; justify-content: space-between; align-items: flex-end; margin-bottom: 48px; }
.v1-eyebrow { font-size: 11px; font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase; color: #9a9388; margin-bottom: 12px; }
.v1-section-title { font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 400; font-style: italic; font-size: 46px; line-height: 1.1; margin: 0; }
.v1-all-link { font-size: 12px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; color: #8a6a35; border-bottom: 1px solid #8a6a35; padding-bottom: 4px; }

/* Events column */
.v1-events h2, .v1-readings h2 { font-family: 'Cormorant Garamond', Georgia, serif; font-style: italic; font-size: 38px; margin: 0 0 24px; }
.v1-col-head { margin-bottom: 8px; }
.v1-event-item { display: flex; gap: 20px; align-items: flex-start; padding: 16px 0; border-bottom: 1px solid #e6dcc9; }
.v1-event-date { text-align: center; min-width: 48px; }
.v1-event-m { font-size: 11px; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #8a6a35; }
.v1-event-d { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 36px; font-weight: 500; line-height: 1; color: #1f1a13; }
.v1-event-feast { font-weight: 600; color: #1f1a13; margin-bottom: 4px; }
.v1-event-time { font-size: 12px; color: #9a9388; letter-spacing: 0.06em; }
.v1-all-btn { display: inline-block; margin-top: 24px; font-size: 12px; font-weight: 600; letter-spacing: 0.18em; text-transform: uppercase; color: #8a6a35; border-bottom: 1px solid #8a6a35; padding-bottom: 4px; }

/* Daily Readings */
.v1-read-item { padding: 12px 0; border-bottom: 1px solid #e6dcc9; }
.v1-day-tag { font-size: 11px; font-weight: 700; letter-spacing: 0.14em; text-transform: uppercase; color: #8a6a35; margin-bottom: 4px; }
.v1-feast-name { font-size: 15px; color: #1f1a13; }
.v1-readings-widget { margin-top: 16px; }

/* Annual Appeal */
.v1-appeal { background: #faf6ef; padding: 80px 0; }
.v1-appeal-head { text-align: center; margin-bottom: 56px; }
.v1-appeal-head h2 { font-family: 'Cormorant Garamond', Georgia, serif; font-style: italic; font-size: 46px; margin: 8px 0 0; }
.v1-appeal-grid { display: grid; grid-template-columns: 1fr 2fr 2fr; gap: 48px; }
.v1-appeal-brochure img { width: 100%; display: block; box-shadow: 0 8px 24px rgba(40,28,10,0.18); }
.v1-donate-row { display: flex; gap: 12px; margin: 20px 0 12px; }
.v1-btn-solid { flex: 1; text-align: center; background: #8a6a35; color: white; padding: 12px; font-size: 13px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; }
.v1-btn-solid:hover { background: #6b5126; }
.v1-btn-out { display: block; text-align: center; border: 1px solid #8a6a35; color: #8a6a35; padding: 12px; font-size: 12px; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; }
.v1-lang-tag { display: inline-block; background: #8a6a35; color: white; font-size: 11px; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; padding: 6px 12px; margin-bottom: 16px; }
.v1-appeal-video { margin-bottom: 20px; }
.v1-appeal-video iframe { width: 100%; aspect-ratio: 16/9; border: 0; display: block; }
.v1-appeal-lang-col p { font-size: 14px; line-height: 1.7; color: #3b342a; }
```

---

## LAYOUT CHANGES REQUIRED

Beyond particle HTML, the following structural/layout changes are needed:

| Change | Detail |
|--------|--------|
| Hero layout | Swiper block stays at 67%, Mass Times block shrinks to ~38% with negative margin or absolute positioning to overlay the hero edge |
| Expanded section | Add 3rd column for Sponsors (currently only Calendar + Daily Readings at 50%/50%) |
| News grid CSS | `.j-news` contentarray output needs CSS to split 1st article as featured card vs. remaining as side cards |
| Cormorant Garamond font | Add `<link>` to Google Fonts in Gantry Page Settings → Head → Custom HTML |

---

## PARTICLE ID REFERENCE

| Particle | ID | Section | Type |
|----------|----|---------|------|
| Contact Information | `custom-4575` | Top/Nav | custom |
| Swiper (hero) | `swiper-7419` | Slideshow | swiper |
| Mass Times | `contentarray-2192` | Slideshow | contentarray |
| Standard Quicklinks | `blockcontent-5975` | Header | blockcontent |
| Headlines Title | `custom-9454` | Mainbar | custom |
| Current News & Events | `contentarray-9256` | Mainbar | contentarray |
| Calendar | `custom-9782` | Expanded | custom |
| Daily Readings | `custom-2954` | Expanded | custom |
| Annual Appeal | `custom-9368` | Extension | custom |
