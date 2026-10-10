import { createFileRoute } from "@tanstack/react-router";
import { HexScroll } from "@/components/hex-scroll";
import { CONTENT_ROWS } from "@/components/hex-content";
import { HEX_ROW_STEP } from "@/lib/hex-grid";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PetroGrid — Forecasting Gulf Coast cascade risk" },
      { name: "description", content: "PetroGrid simulates the Gulf Coast petrochemical network so every plant knows how long it has, what it costs and its best move." },
      { property: "og:title", content: "PetroGrid — Forecasting Gulf Coast cascade risk" },
      { property: "og:description", content: "One coast makes almost all of America's plastics feedstock. PetroGrid gives it one model." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <main className="identity-study">
      <HexScroll />
      <div style={{ height: 80 + CONTENT_ROWS * HEX_ROW_STEP }} aria-hidden="true" />
    </main>
  );
}
