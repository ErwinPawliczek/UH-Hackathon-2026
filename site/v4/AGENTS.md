<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture
- Keep the main pitch at / and the v5 video placeholder at /video, sharing one grid scene with mode-specific content; this preserves both experiences without replacing the pitch.
- Generate QR assets from the centralized site-link definitions and keep their quiet zones intact; this keeps main-page and demo codes reliably scannable.
- Keep the hexagonal scroll study in a dedicated SVG scene, with the exact source logo in a separate mark component and snapping geometry in a tested pure module; this keeps logo preservation independent of scroll behavior.
- Keep the v5 video aperture in a separate SVG component built from the existing cell geometry, with a matching clipping path and pure responsive layout module; future video media can replace the placeholder without changing the grid or brand behavior.
- Apply scroll updates through requestAnimationFrame and use hysteresis for neighboring grid selection; animate only the brand's hop with an interruptible Web Animation, bypassed for reduced motion, so ordinary scrolling stays registered with the lattice.
- Paint the lattice as a document-attached SVG pattern that scrolls natively, with the brand placed on the same sheet at its snap row's page position, and derive every hexagon dimension and wordmark offset from one grid-scale constant; native scrolling guarantees the grid visibly moves with zero lag and the brand only re-renders on a hop.
- Place pitch content through the single pure layout engine (src/lib/pitch-layout.ts) with fixed width tiers shared by every page; layouts stay centered on the grid and testable per screen size.
- Mask only the main-page wordmark with a softened document-space mask derived from pitch layout items, and synchronize its hop with the unmasked mark; this keeps content readable without moving the lattice or hiding the logo.
- Keep QR-specific presentation isolated and follow QR_PAGE_CONTEXT.md when editing shared files; this prevents main-page changes from altering the approved QR experience.
- Derive QR placement in the independent qr-layout module rather than importing pitch content; this makes the approved page transferable without replacing the host site's pitch.
