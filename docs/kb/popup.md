# KB — Homepage Popup Setup

How to add a timed popup announcement to a site's homepage using a Gantry 5 particle + category-based module.

---

## How It Works

JavaScript detects whether a published article exists in the `pop-up` category. If one exists, it displays the article content in a popup overlay after a configurable delay. Cookies track how many times a user has seen it.

**Defaults:** Shows after 3 seconds, up to 50 times per week. Cookies expire after 7 days.

---

## Setup Steps

### 1. Create the "pop-up" Category
Create a new Joomla category named `pop-up`. Any published article in this category will appear in the popup.

### 2. Add JavaScript to the Home Outline in Gantry

In the home outline's JavaScript section, add:
```javascript
showPopup2();
```

To customize behavior, pass three parameters in order:
```javascript
showPopup2(visitLimit, expirationDays, delayMs);
// Example: 5 visits max, resets after 30 days, 5-second delay
showPopup2(5, 30, 5000);
```

### 3. Add the Custom HTML Particle to the Top Section of the Home Outline

```html
<div id="pop-up-overlay-2"></div>
<div id="pop-up-container-2">
  <div id="popup-2">
    <jdoc:include type="modules" name="pop-up" />
  </div>
  <button id="close-popup-button-2"><i class="fas fa-times-circle"></i></button>
</div>
```

The `name="pop-up"` attribute must match the module position defined in step 5.

### 4. Hide the Particle When No Article Is Published

In the custom CSS particle (block section), add the class: `pop-up-block-2`

This hides the popup container when the category has no published articles.

### 5. Create the Module

- Type: **Place Here**
- Display: a category (use the ID of the `pop-up` category from Category Manager)
- Position: `pop-up` (must match the `name` attribute in the `<jdoc>` tag above)
- First 5 radio buttons: **No**
- Article order: **Ascending**
- Menu Assignment: **All pages** (or at minimum, the home menu item)

### 6. Test

Publish an article in the `pop-up` category and load the homepage. The popup appears after the delay.

**To reset popup cookies for testing:**
1. Open browser developer tools → Application tab.
2. Under Storage → Cookies → select the site URL.
3. Delete the visit count cookies.
