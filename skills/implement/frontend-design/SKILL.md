---
name: frontend-design
description: "Create distinctive, production-grade frontend interfaces with high design quality. Use when building web components, pages, dashboards, React components, or HTML/CSS layouts. Triggers on: frontend design, UI design, build landing page, create dashboard, design website, style component, /frontend-design."
---

# Frontend Design

Create distinctive, production-grade frontend interfaces that avoid generic "AI slop" aesthetics. Adapted from Anthropic's frontend-design skill (MIT license).

---

## The Job

Implement real working code with exceptional attention to aesthetic details and creative choices:

1. **Understand Context**: What problem does this interface solve? Who uses it?
2. **Choose Bold Direction**: Commit to a clear aesthetic with intentionality
3. **Implement Code**: Production-grade, functional, visually striking
4. **Refine Details**: Meticulously polish every element

---

## Design Philosophy: Avoiding "AI Slop"

Generic AI-generated aesthetics are immediately recognizable and feel lifeless. **NEVER** default to:

| Category | Avoid |
|----------|-------|
| Typography | Inter, Roboto, Arial, system fonts |
| Colors | Purple gradients on white, overused palettes |
| Layouts | Predictable grids, cookie-cutter patterns |
| Components | Generic cards, same-looking dashboards |

**Instead**: Make unexpected choices that feel genuinely designed for the context. No two designs should be the same.

---

## Design Thinking

Before coding, commit to a **BOLD** aesthetic direction:

### Tone Options

Choose an intentional aesthetic (not random, but purposeful):

- **Brutally minimal** - Extreme restraint, precision spacing
- **Maximalist chaos** - Elaborate, layered, expressive
- **Retro-futuristic** - Nostalgic tech meets modern
- **Organic/natural** - Soft forms, earthy palette
- **Luxury/refined** - Premium feel, sophisticated
- **Playful/toy-like** - Fun, approachable, colorful
- **Editorial/magazine** - Typography-forward, grid-based
- **Brutalist/raw** - Exposed structure, honest materials
- **Art deco/geometric** - Bold shapes, metallic accents
- **Soft/pastel** - Gentle, approachable, calming
- **Industrial/utilitarian** - Functional, no-nonsense

### Key Questions

1. **Purpose**: What problem does this interface solve?
2. **Audience**: Who uses it? What do they expect?
3. **Constraints**: Framework, performance, accessibility requirements
4. **Differentiation**: What's the ONE thing someone will remember?

---

## Typography System

### Font Selection

Choose fonts that are **beautiful, unique, and interesting**:

```css
/* GOOD - Distinctive, characterful */
--font-display: 'Playfair Display', serif;
--font-body: 'Source Sans Pro', sans-serif;

/* BAD - Generic, forgettable */
--font-display: 'Inter', sans-serif;
--font-body: 'Roboto', sans-serif;
```

### Pairing Strategy

- **Display font**: Distinctive, attention-grabbing for headlines
- **Body font**: Refined, readable for content
- Create tension between the two (serif + sans, geometric + organic)

### Typography Scale

```css
:root {
  --text-xs: clamp(0.75rem, 1vw, 0.875rem);
  --text-sm: clamp(0.875rem, 1.5vw, 1rem);
  --text-base: clamp(1rem, 2vw, 1.125rem);
  --text-lg: clamp(1.25rem, 2.5vw, 1.5rem);
  --text-xl: clamp(1.5rem, 3vw, 2rem);
  --text-2xl: clamp(2rem, 4vw, 3rem);
  --text-hero: clamp(3rem, 8vw, 6rem);
}
```

---

## Color System

### Commit to a Cohesive Palette

Dominant colors with sharp accents outperform timid, evenly-distributed palettes.

```css
:root {
  /* Primary - Bold statement color */
  --color-primary: #0A0A0A;
  --color-primary-accent: #FF3D00;

  /* Backgrounds - Create depth */
  --color-bg-base: #FAFAFA;
  --color-bg-elevated: #FFFFFF;
  --color-bg-sunken: #F0F0F0;

  /* Text - Clear hierarchy */
  --color-text-primary: #0A0A0A;
  --color-text-secondary: #666666;
  --color-text-muted: #999999;

  /* Semantic - Contextual meaning */
  --color-success: #00C853;
  --color-warning: #FFD600;
  --color-error: #FF1744;
}
```

### Theme Variation

Vary between light and dark themes. Don't always default to one:

```css
/* Dark theme example */
:root[data-theme="dark"] {
  --color-bg-base: #0A0A0A;
  --color-bg-elevated: #1A1A1A;
  --color-text-primary: #FAFAFA;
}
```

---

## Spatial Composition

### Layout Principles

- **Asymmetry** - Avoid perfectly centered everything
- **Overlap** - Elements that break boundaries
- **Diagonal flow** - Guide eye movement creatively
- **Grid-breaking** - Intentional violations of the grid
- **Negative space** - Generous OR controlled density

### Spacing System

```css
:root {
  --space-xs: 0.25rem;
  --space-sm: 0.5rem;
  --space-md: 1rem;
  --space-lg: 2rem;
  --space-xl: 4rem;
  --space-2xl: 8rem;
  --space-section: clamp(4rem, 10vw, 8rem);
}
```

---

## Motion & Animation

### Philosophy

Focus on **high-impact moments**: one well-orchestrated page load with staggered reveals creates more delight than scattered micro-interactions.

### Implementation

```css
/* Staggered reveal animation */
.reveal-item {
  opacity: 0;
  transform: translateY(20px);
  animation: reveal 0.6s ease forwards;
}

.reveal-item:nth-child(1) { animation-delay: 0.1s; }
.reveal-item:nth-child(2) { animation-delay: 0.2s; }
.reveal-item:nth-child(3) { animation-delay: 0.3s; }

@keyframes reveal {
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
```

### Priority

1. **Page load orchestration** - First impression
2. **Scroll-triggered reveals** - Progressive discovery
3. **Hover states that surprise** - Micro-delight
4. **Transitions between states** - Smooth, intentional

---

## Visual Details & Atmosphere

### Background Treatments

Don't default to solid colors. Create atmosphere:

```css
/* Gradient mesh */
.bg-mesh {
  background:
    radial-gradient(at 20% 80%, rgba(255, 61, 0, 0.15) 0%, transparent 50%),
    radial-gradient(at 80% 20%, rgba(0, 200, 83, 0.1) 0%, transparent 50%),
    linear-gradient(180deg, #FAFAFA 0%, #F0F0F0 100%);
}

/* Noise texture */
.bg-noise::before {
  content: '';
  position: absolute;
  inset: 0;
  background: url("data:image/svg+xml,...") repeat;
  opacity: 0.03;
  pointer-events: none;
}
```

### Visual Effects Palette

- **Gradient meshes** - Multi-point color blending
- **Noise textures** - Organic, print-like quality
- **Geometric patterns** - Bold, architectural
- **Layered transparencies** - Depth and dimension
- **Dramatic shadows** - Elevate important elements
- **Decorative borders** - Frame content intentionally
- **Custom cursors** - Brand personality
- **Grain overlays** - Film-like quality

---

## Component Patterns

### Cards with Personality

```css
/* Premium card */
.card-premium {
  background: linear-gradient(135deg, #1a1a1a 0%, #0a0a0a 100%);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 1.5rem;
  padding: var(--space-xl);
  box-shadow:
    0 25px 50px -12px rgba(0, 0, 0, 0.5),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  transition: transform 0.3s ease, box-shadow 0.3s ease;
}

.card-premium:hover {
  transform: translateY(-4px);
  box-shadow:
    0 35px 60px -15px rgba(0, 0, 0, 0.6),
    inset 0 1px 0 rgba(255, 255, 255, 0.15);
}
```

### Buttons with Character

```css
/* Bold action button */
.btn-action {
  background: var(--color-primary-accent);
  color: white;
  font-weight: 600;
  padding: var(--space-md) var(--space-xl);
  border: none;
  border-radius: 0.5rem;
  cursor: pointer;
  position: relative;
  overflow: hidden;
  transition: transform 0.2s ease;
}

.btn-action::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, transparent, rgba(255,255,255,0.2), transparent);
  transform: translateX(-100%);
  transition: transform 0.5s ease;
}

.btn-action:hover::before {
  transform: translateX(100%);
}
```

---

## Framework Considerations

### HTML/CSS

- Prioritize CSS-only animations
- Use modern CSS (grid, flexbox, clamp, custom properties)
- Progressive enhancement for older browsers

### React

- Use Motion library (formerly Framer Motion) for animations when available
- Component composition for reusable patterns
- CSS-in-JS or CSS Modules for scoped styles

### Vue

- Transition components for animations
- Scoped styles with preprocessors
- Composables for shared behavior

---

## Implementation Complexity

**Match implementation complexity to aesthetic vision**:

| Vision | Implementation |
|--------|----------------|
| **Maximalist** | Elaborate code, extensive animations, rich effects |
| **Minimalist** | Restraint, precision, subtle details |
| **Refined** | Careful spacing, typography focus, polish |

**Elegance comes from executing the vision well**, not from complexity itself.

---

## Final Checklist

Before delivering:

- [ ] Clear aesthetic direction chosen and executed
- [ ] No generic AI aesthetics (fonts, colors, patterns)
- [ ] Typography system with distinctive choices
- [ ] Color system with CSS variables
- [ ] Intentional spatial composition
- [ ] Motion design for key moments
- [ ] Visual details that create atmosphere
- [ ] Production-ready, functional code
- [ ] Accessible (color contrast, focus states)

---

## Attribution

Based on Anthropic's frontend-design skill from [anthropics/skills](https://github.com/anthropics/skills) (MIT license).
