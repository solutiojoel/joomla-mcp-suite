# KB — Animate on Scroll

How to add scroll-triggered animations to grid/article sections using the Solutio animate-on-scroll system.

---

## Requirements

The following files must be present in the outline:
- `particle.js`
- `particle.css`

Currently only works with the **Headlines** particle.

---

## Setup Steps

### 1. Add the CSS class to the particle

In the Joomla Articles particle settings, add the class `animate-headlines`.

### 2. Add JavaScript to the outline

In the outline's JavaScript section, call:

```javascript
animateOnScroll('fade-up', true);
```

Available animation names: `slide-in`, `fade-up`, `zoom-in`

The second parameter (`true`) means the animation plays only once. Set to `false` to replay each time the element scrolls into view.

---

## Creating Custom Animations

All animations are defined in CSS. Pass the animation class name as the first argument to `animateOnScroll()`.

### 1. Define the keyframes

```css
@keyframes example-animation-class {
  from {
    opacity: 0;
    filter: blur(1px);
    transform: translateY(30px);
  }
  to {
    opacity: 1;
    filter: blur(0);
    transform: translateY(0px);
  }
}
```

### 2. Apply to the grid (staggered children)

```css
.g-joomla-articles:has(.example-animation-class) > .g-grid:nth-child(1) {
  animation: example-animation-class 1s ease-in-out 0ms forwards;
}
```

Each `:nth-child()` can have a different delay for a staggered effect.

### 3. Add to the "non-animated" fallback selector in particle.css

```css
div:has([class*="animate-"]) .g-joomla-articles > .g-grid:not(.hidden-element, .fade-up, .zoom-in, .slide-in, .example-animation-class) {
  animation: show-element 750ms ease-in-out forwards;
}
```

This ensures paginated articles still get a basic animation.

### 4. Set initial opacity to 0

```css
.fade-up, .zoom-in, .slide-in, .example-animation-class {
  opacity: 0;
}
```

This hides elements on page load. The `forwards` fill mode in the animation keeps the final state (opacity: 1) after it plays.
