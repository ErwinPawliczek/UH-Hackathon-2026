## Architecture
- Keep the hexagonal scroll study in a dedicated SVG scene, the source logo in a separate mark component, and snapping geometry in a tested pure module; logo preservation stays independent of scroll behavior.
- Apply scroll updates through requestAnimationFrame with hysteresis, animating only the brand hop through an interruptible Web Animation with reduced-motion bypass; the document-attached lattice scrolls natively without lag.
- Derive cell geometry and wordmark offsets from the shared grid scale; all content remains registered with the lattice.
- Keep the v5 video aperture in a separate SVG component built from existing cells, with a matching clipping path; future media can replace the placeholder without altering grid or logo behavior.
