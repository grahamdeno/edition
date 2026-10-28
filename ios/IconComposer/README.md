# Shoebox icon layers for Icon Composer

Three layers on a 1024 × 1024 canvas, transparent background, solid fills (Liquid Glass adds the light and depth):

| Group (top to bottom) | File | Fill |
|---|---|---|
| Front | `lid.svg` | Gold #FFD23F |
| Middle | `box.svg` | Cream #FFF7DA |
| Back | `cards.svg` | Lavender #E2D4FF |

Background fill: violet #7B3FF2 (dark appearance: #1B1033).

`preview.svg` / `preview.png` show the flat composite. `ios/App/AppIcon.icon` is built from these (icon.json by hand, the three SVGs in Assets). Xcode makes the icons for iOS before 26 from it. Open it in Icon Composer on a Mac to fine-tune the glass.
