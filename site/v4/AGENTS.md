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
- Keep the hexagonal scroll study in a dedicated SVG scene, with the exact source logo in a separate mark component and snapping geometry in a tested pure module; this keeps logo preservation independent of scroll behavior.
- Apply scroll updates through requestAnimationFrame and use hysteresis for neighboring grid selection; animate only the brand's hop with an interruptible Web Animation, bypassed for reduced motion, so ordinary scrolling stays registered with the lattice.
- Paint the lattice as a document-attached SVG pattern that scrolls natively, with the brand placed on the same sheet at its snap row's page position, and derive every hexagon dimension and wordmark offset from one grid-scale constant; native scrolling guarantees the grid visibly moves with zero lag and the brand only re-renders on a hop.
