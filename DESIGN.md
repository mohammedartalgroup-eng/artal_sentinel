# Design System Specification: Artal Security Guards

## 1. Overview & Creative North Star
**The Creative North Star: "The Digital Fortress"**

This design system moves away from the aggressive, tactical aesthetic often found in the security sector. Instead, it adopts the persona of a "High-End Concierge of Safety." We prioritize **Authoritative Elegance**—merging the unwavering strength of traditional security with the seamless, invisible sophistication of modern technology.

The system rejects the "template" look by utilizing **Intentional Asymmetry** and **Tonal Depth**. Rather than rigid grids, we use breathing room (negative space) and layered surfaces to guide the eye. The visual language is designed to feel custom-tailored, suggesting that security for the client is not a commodity, but a premium, bespoke service.

---

## 2. Colors: The Palette of Trust
The palette is rooted in deep, nocturnal blues and charcoal grays, punctuated by "Metallic" gold accents to signify excellence and value.

### Color Roles
- **Primary (`#001736`) & Primary Container (`#002b5b`):** The foundation. These represent depth, stability, and the "Night Watch."
- **Tertiary Fixed (`#ffdf9e`) & Tertiary Container (`#3a2900`):** These "Gold" tokens are used sparingly for high-value callouts and critical security indicators.
- **Surface Scale:** We utilize the full range from `surface-container-lowest` (#ffffff) to `surface-dim` (#d8dadc) to build architecture without lines.

### The "No-Line" Rule
**Explicit Instruction:** Designers are prohibited from using 1px solid borders to section content. Boundaries must be defined solely through:
1. **Background Color Shifts:** Use `surface-container-low` for a section background to distinguish it from the main `surface` (#f8f9fb).
2. **Tonal Transitions:** A subtle shift from `surface` to `surface-container` creates a natural break that feels organic rather than mechanical.

### The "Glass & Gradient" Rule
To elevate the UI, hero sections and floating navigation should utilize **Glassmorphism**. Use semi-transparent versions of `primary_container` with a `backdrop-blur` (20px+) to create a "Command Center" feel. 
*   **Signature Texture:** Apply a linear gradient from `primary` to `primary_container` on main CTAs to add "soul" and a sense of three-dimensional depth.

---

## 3. Typography: Editorial Authority
The typography uses a high-contrast scale to mimic premium editorial layouts. We pair **Manrope** (for its geometric stability) with **Inter** (for its technical precision). For Arabic, these choices translate to clean, high-x-height Naskh styles that ensure legibility in high-stress security contexts.

- **Display (Manrope):** Large, bold, and authoritative. Used for key value propositions.
- **Headline (Manrope):** Structured and confident.
- **Body (Inter):** Highly legible. Used for reports, descriptions, and legal fine print.
- **Label (Inter):** Technical and precise. Used for metadata and status indicators.

*Implementation Note: Always maintain a generous line-height (1.5x - 1.6x) for Arabic body text to accommodate diacritics and prevent visual "clutter."*

---

## 4. Elevation & Depth: Tonal Layering
We do not use shadows to create "pop"; we use layering to create **Hierarchy.**

### The Layering Principle
Think of the UI as a physical desk.
1.  **Base:** `surface` (#f8f9fb).
2.  **Sectioning:** `surface-container-low` (#f2f4f6).
3.  **Floating Cards:** `surface-container-lowest` (#ffffff).
This "nesting" creates natural depth. An element is "higher" because it is lighter, not because it has a dark shadow.

### Ambient Shadows
If an element must float (e.g., a critical Alert Modal), use an **Ambient Shadow**:
- **Color:** `on-surface` (#191c1e) at 4% opacity.
- **Blur:** 40px - 60px.
- **Spread:** -10px.
This mimics natural light dispersion in a high-end architectural space.

### The "Ghost Border" Fallback
If a container requires a boundary (e.g., in high-glare environments), use a **Ghost Border**: `outline-variant` (#c4c6d0) at 15% opacity. Never use 100% opaque lines.

---

## 5. Components: Precision & Premium Feel

### Buttons (The "Command" Elements)
- **Primary:** Gradient from `primary` to `primary_container`. Roundedness: `md` (0.75rem). No border.
- **Tertiary (Gold):** Use `tertiary_fixed_dim` for a "VIP" action.
- **Interaction:** On hover, increase the gradient intensity; do not use a simple color overlay.

### Cards & Lists (The "Intelligence" Feed)
- **Rule:** Forbid divider lines. 
- **Separation:** Use `spacing-lg` (vertical white space) and subtle shifts between `surface-container-low` and `surface-container-high`.
- **Corner Radius:** Use `xl` (1.5rem) for main dashboard cards to soften the technical nature of security data.

### Input Fields
- **State:** Active inputs use a `primary` "Ghost Border" (20% opacity) and a subtle `primary_container` glow.
- **Typography:** Labels use `label-md` in `on_surface_variant`.

### Security-Specific Components
- **Status Badges:** Use `tertiary_container` for "Secure" status and `error_container` for "Alert," but keep the `on_error_container` text highly legible.
- **Tactical Map Overlays:** Use Glassmorphism (Surface-tint with 60% opacity and blur) for floating map controls.

---

## 6. Do's and Don'ts

### Do
- **Use "The Breath":** Give every headline significant top-margin to create an editorial feel.
- **Layer your Grays:** Use the `surface-container` tiers to create a "Control Room" hierarchy.
- **Respect the Script:** Ensure Arabic text has enough "Leading" (line spacing) to look premium.

### Don't
- **Don't use 1px black/gray borders:** It breaks the "Fortress" immersion and looks like a generic template.
- **Don't use "Pure" Black:** Use `primary` (#001736) or `on_surface` (#191c1e) for shadows and text to maintain tonal richness.
- **Don't use Sharp Corners:** Security doesn't have to be "sharp." Use the `md` and `lg` roundedness scale to convey a modern, approachable sense of safety.