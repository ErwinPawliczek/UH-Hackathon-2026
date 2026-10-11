import { createFileRoute } from "@tanstack/react-router";
import { HexScroll } from "@/components/hex-scroll";
import { SiteQrCodes } from "@/components/site-qr-codes";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "PetroGrid — Gulf Coast Cascade Risk" },
      { name: "description", content: "One coast. One model. PetroGrid models Gulf Coast cascade risk, disruption costs, and the best next move." },
      { property: "og:title", content: "PetroGrid — Gulf Coast Cascade Risk" },
      { property: "og:description", content: "PetroGrid models the whole network so every plant knows its move." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

function Index() {
  return (
    <main className="identity-study identity-pitch">
      <HexScroll mode="pitch" />
      <SiteQrCodes />
    </main>
  );
}
