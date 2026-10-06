---
status: accepted
---

# Variants are vanilla static sites with no build step

Every variant, for every profile, is plain HTML, hand-authored CSS and JS modules. Its dependencies (GSAP, Lenis, Three, vanilla Motion) are vendored with exact versions, and it is served as-is. We chose this even though 11 of the 20 section and component libraries we surveyed are React-only. A variant's look comes from measurements of live reference sites: authored CSS, real font files, scroll-trigger parameters. That data ports straight to vanilla code. The libraries contribute section skeletons and motion mechanics, not the look. The sources with award-level looks (Codrops, GSAP demos, Webflow sites) are vanilla already. In the project this skill was distilled from, five vanilla variants were built in parallel in 31–54 minutes each.

## Considered Options

- **React or Next + Tailwind for every profile.** Library components would drop in as they are. But Tailwind's default scale rounds measured values away (`28.8px`, custom easings). Its defaults are known AI-look markers. Every edit needs a rebuild. And motion components freeze mid-animation in headless screenshots.
- **Vanilla for look-led profiles, React for e-commerce and web apps.** React sources are richer for these two profiles. But two formats mean two sets of QA checks, two builder procedures and two polish procedures. Most React blocks are static JSX (83 % in our sample), and they port mechanically.

## Consequences

- **React islands.** A React component that cannot reasonably be ported becomes a single pre-built island per variant, about 180 KB gzip, because each island bundles its own React. The reason is recorded in the variant's `SOURCES.md`.
- **Shared page parts.** Header and footer are duplicated across a variant's pages rather than included by a build step, and `sp qa` checks that the copies are identical.
- **Revisit trigger.** Revisit this decision for the web app / dashboard profile if its exam run shows porting React sources costs more than building in React would.
