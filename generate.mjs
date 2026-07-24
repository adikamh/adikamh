#!/usr/bin/env node
/**
 * Generates an animated "jet over contribution grid" SVG using a GitHub
 * user's REAL contribution calendar (last 34 weeks, same layout as
 * GitHub's own heatmap: 34 columns x 7 rows).
 *
 * Supports generating both Dark Mode and Light Mode SVG variants.
 *
 * Env vars:
 *   GH_USERNAME  - GitHub login to fetch contributions for (required)
 *   GH_TOKEN     - token with access to the GraphQL API (required).
 *   OUTPUT_PATH  - where to write the SVG (default: dist/github-jet.svg)
 *   THEME        - dark or light (default: dark)
 */

import fs from "node:fs";
import path from "node:path";

const USERNAME = process.env.GH_USERNAME || "adikamh";
const TOKEN = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
const OUTPUT = process.env.OUTPUT_PATH || "dist/github-jet.svg";
const COLS = 34; // weeks shown, matches the reference design
const ROWS = 7;
const CELL = 11;
const STEP = 14; // cell + gap
const GRID_X = 20;
const GRID_Y = 15;
const WIDTH = 513;
const HEIGHT = 170;
const JET_X_START = 35;
const JET_X_END = 478;
const LOOP_DUR = 20; // seconds, one full there-and-back pass
const MAX_TARGETS = 12; // how many "busiest" days the jet fires on
const PAD_Y = 128; // where bullets launch from (just under the grid)

const THEMES = {
  dark: {
    bg: "#0d1117",
    emptyCell: "#161b22",
    levels: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
    flash: "#39d353",
    bullet: "#7ee787",
    blast: "#56d364",
    star: "#8b949e",
    jetBody: "#58a6ff",
    jetStroke: "#1f6feb",
    jetWing: "#388bfd",
    jetCockpit: "#c9e6ff",
    jetFlame: "#f0883e",
  },
  light: {
    bg: "#f8fafc",
    emptyCell: "#e2e8f0",
    levels: ["#e2e8f0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    flash: "#216e39",
    bullet: "#30a14e",
    blast: "#40c463",
    star: "#94a3b8",
    jetBody: "#0284c7",
    jetStroke: "#0369a1",
    jetWing: "#0ea5e9",
    jetCockpit: "#e0f2fe",
    jetFlame: "#f97316",
  },
};

const QUERY = `
  query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        contributionCalendar {
          weeks {
            contributionDays {
              date
              contributionCount
              color
            }
          }
        }
      }
    }
  }
`;

async function fetchWeeks() {
  if (TOKEN && !TOKEN.startsWith("fake")) {
    try {
      const res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: {
          Authorization: `bearer ${TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query: QUERY, variables: { login: USERNAME } }),
      });
      if (res.ok) {
        const json = await res.json();
        if (!json.errors && json.data?.user?.contributionsCollection?.contributionCalendar?.weeks) {
          return json.data.user.contributionsCollection.contributionCalendar.weeks;
        }
      }
    } catch (err) {
      console.warn("GraphQL fetch failed, using public API fallback:", err.message);
    }
  }

  console.log(`Fetching real contribution calendar for ${USERNAME}...`);
  const res = await fetch(`https://github-contributions-api.jogruber.de/v4/${USERNAME}?y=last`);
  if (!res.ok) {
    throw new Error(`Failed to fetch public contributions: ${res.statusText}`);
  }
  const json = await res.json();
  const contributions = json.contributions || [];

  const recentDays = contributions.slice(-(COLS * ROWS));
  const weeks = [];
  for (let i = 0; i < recentDays.length; i += ROWS) {
    const chunk = recentDays.slice(i, i + ROWS);
    const contributionDays = chunk.map(day => ({
      date: day.date,
      contributionCount: day.count,
      level: day.level !== undefined ? day.level : (day.count === 0 ? 0 : day.count < 2 ? 1 : day.count < 5 ? 2 : day.count < 10 ? 3 : 4),
    }));
    weeks.push({ contributionDays });
  }
  return weeks;
}

function getDayColor(day, theme) {
  if (!day || day.contributionCount === 0) return theme.emptyCell;
  let level = day.level;
  if (level === undefined) {
    const cnt = day.contributionCount;
    level = cnt === 0 ? 0 : cnt <= 2 ? 1 : cnt <= 5 ? 2 : cnt <= 9 ? 3 : 4;
  }
  return theme.levels[level] || theme.levels[1];
}

function buildCells(weeks, theme) {
  const recent = weeks.slice(-COLS);
  const padCount = COLS - recent.length;
  const padded = Array.from({ length: padCount }, () => ({
    contributionDays: Array.from({ length: ROWS }, () => ({
      contributionCount: 0,
      level: 0,
      date: null,
    })),
  })).concat(recent);

  const cells = [];
  padded.forEach((week, col) => {
    week.contributionDays.forEach((day, row) => {
      cells.push({
        col,
        row,
        x: GRID_X + col * STEP,
        y: GRID_Y + row * STEP,
        color: getDayColor(day, theme),
        count: day.contributionCount || 0,
        date: day.date,
      });
    });
  });
  return cells;
}

function pickTargets(cells) {
  return [...cells]
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_TARGETS)
    .sort((a, b) => a.col - b.col || a.row - b.row);
}

function jetTimeForCol(col, dir) {
  const cx = GRID_X + col * STEP + CELL / 2;
  const dist = JET_X_END - JET_X_START;
  let t = (cx - JET_X_START) / (2 * dist);
  t = Math.max(0.01, Math.min(0.49, t));
  return dir === "forward" ? t : 1.0 - t;
}

function fmt(n) {
  return Number(n.toFixed(4));
}

function buildGrid(cells, targets, theme) {
  const targetMap = new Map();
  for (const t of targets) {
    targetMap.set(`${t.col}-${t.row}`, t);
  }

  let svg = "";
  for (const c of cells) {
    const isTarget = targetMap.has(`${c.col}-${c.row}`);
    if (!isTarget) {
      svg += `<rect x="${c.x.toFixed(2)}" y="${c.y.toFixed(2)}" width="${CELL}" height="${CELL}" rx="2" ry="2" fill="${c.color}"/>\n`;
      continue;
    }

    const targetY = c.y + CELL / 2;
    const dt_bullet = 0.006 + ((PAD_Y - targetY) / PAD_Y) * 0.012;

    const tFwdImpact = jetTimeForCol(c.col, "forward") + dt_bullet;
    const tBackImpact = jetTimeForCol(c.col, "backward") + dt_bullet;

    const [t1, t2] = [Math.min(tFwdImpact, tBackImpact), Math.max(tFwdImpact, tBackImpact)];
    const dur = 0.015;

    svg += `<rect x="${c.x.toFixed(2)}" y="${c.y.toFixed(2)}" width="${CELL}" height="${CELL}" rx="2" ry="2" fill="${c.color}">` +
      `<animate attributeName="fill" dur="${LOOP_DUR}s" repeatCount="indefinite" ` +
      `keyTimes="0;${fmt(t1)};${fmt(t1 + dur)};${fmt(t2)};${fmt(t2 + dur)};1" ` +
      `values="${c.color};${theme.flash};${c.color};${theme.flash};${c.color};${c.color}"/>` +
      `</rect>\n`;
  }
  return svg;
}

function buildBulletsAndBlasts(targets, theme) {
  let bullets = "";
  let blasts = "";

  for (const dir of ["forward", "backward"]) {
    const ordered = dir === "forward" ? targets : [...targets].reverse();
    for (const c of ordered) {
      const cx = fmt(c.x + CELL / 2);
      const targetY = fmt(c.y + CELL / 2);

      const tLaunch = jetTimeForCol(c.col, dir);
      const dt_bullet = 0.006 + ((PAD_Y - targetY) / PAD_Y) * 0.012;
      const tImpact = tLaunch + dt_bullet;
      const tFadeEnd = tImpact + 0.005;

      bullets += `<circle cx="${cx}" cy="${PAD_Y}" r="2.4" fill="${theme.bullet}">` +
        `<animate attributeName="cy" dur="${LOOP_DUR}s" repeatCount="indefinite" ` +
        `keyTimes="0;${fmt(tLaunch)};${fmt(tImpact)};1" values="${PAD_Y};${PAD_Y};${targetY};${targetY}"/>` +
        `<animate attributeName="opacity" dur="${LOOP_DUR}s" repeatCount="indefinite" ` +
        `keyTimes="0;${fmt(tLaunch)};${fmt(tLaunch + 0.001)};${fmt(tImpact)};${fmt(tFadeEnd)};1" values="0;1;1;1;0;0"/>` +
        `</circle>\n`;

      const blastEnd = tImpact + 0.02;
      blasts += `<circle cx="${cx}" cy="${targetY}" r="0" fill="none" stroke="${theme.blast}" stroke-width="1.8" opacity="0">` +
        `<animate attributeName="r" dur="${LOOP_DUR}s" repeatCount="indefinite" ` +
        `keyTimes="0;${fmt(tImpact)};${fmt(blastEnd)};1" values="0;0;10;10"/>` +
        `<animate attributeName="opacity" dur="${LOOP_DUR}s" repeatCount="indefinite" ` +
        `keyTimes="0;${fmt(tImpact)};${fmt(tImpact + 0.002)};${fmt(blastEnd)};1" values="0;1;1;0;0"/>` +
        `</circle>\n`;
    }
  }
  return { bullets, blasts };
}

function buildStars(theme) {
  const pts = [
    [8, 20, 1.2], [8, 60, 1.6], [8, 100, 2.0],
    [505, 25, 1.2], [505, 70, 1.6], [505, 110, 2.0],
    [30, 164, 1.2], [483, 164, 1.6],
  ];
  return pts.map(([x, y, dur]) =>
    `<circle cx="${x}" cy="${y}" r="1.1" fill="${theme.star}"><animate attributeName="opacity" values="0.2;1;0.2" dur="${dur}s" repeatCount="indefinite"/></circle>`
  ).join("\n");
}

function buildJet(theme) {
  return `<g id="jet">
  <g transform="translate(0,0)">
    <polygon points="0,-16 8,6 4,3 -4,3 -8,6" fill="${theme.jetBody}" stroke="${theme.jetStroke}" stroke-width="1"/>
    <polygon points="-8,6 -14,12 -4,7" fill="${theme.jetWing}"/>
    <polygon points="8,6 14,12 4,7" fill="${theme.jetWing}"/>
    <circle cx="0" cy="-6" r="2.2" fill="${theme.jetCockpit}"/>
    <polygon points="-3,7 3,7 0,15" fill="${theme.jetFlame}">
      <animate attributeName="opacity" values="0.5;1;0.6;1" dur="0.18s" repeatCount="indefinite"/>
    </polygon>
  </g>
  <animateTransform attributeName="transform" attributeType="XML" type="translate"
    dur="${LOOP_DUR}s" repeatCount="indefinite"
    keyTimes="0;0.5;1"
    values="${JET_X_START}.00,140.00;${JET_X_END}.00,140.00;${JET_X_START}.00,140.00"/>
</g>`;
}

function buildSvg(weeks, theme) {
  const cells = buildCells(weeks, theme);
  const targets = pickTargets(cells);
  const { bullets, blasts } = buildBulletsAndBlasts(targets, theme);

  return `<svg viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
<rect x="0" y="0" width="${WIDTH}" height="${HEIGHT}" fill="${theme.bg}"/>
${buildStars(theme)}
<g id="grid">
${buildGrid(cells, targets, theme)}</g>
<g id="bullets">
${bullets}</g>
<g id="blasts">
${blasts}</g>
${buildJet(theme)}
</svg>`;
}

async function main() {
  console.log(`Fetching contributions for ${USERNAME}...`);
  const weeks = await fetchWeeks();

  const isDefaultOutput = OUTPUT === "dist/github-jet.svg";
  
  if (isDefaultOutput) {
    const darkSvg = buildSvg(weeks, THEMES.dark);
    const lightSvg = buildSvg(weeks, THEMES.light);

    const darkPath = path.resolve("dist/github-jet-dark.svg");
    const lightPath = path.resolve("dist/github-jet-light.svg");
    const fallbackPath = path.resolve("dist/github-jet.svg");

    fs.mkdirSync(path.dirname(darkPath), { recursive: true });
    fs.writeFileSync(darkPath, darkSvg, "utf8");
    fs.writeFileSync(lightPath, lightSvg, "utf8");
    fs.writeFileSync(fallbackPath, darkSvg, "utf8");
    console.log(`Wrote ${darkPath}, ${lightPath}, and ${fallbackPath}`);
  } else {
    const themeName = process.env.THEME || "dark";
    const theme = THEMES[themeName] || THEMES.dark;
    const svg = buildSvg(weeks, theme);
    const outPath = path.resolve(OUTPUT);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, svg, "utf8");
    console.log(`Wrote ${outPath} (${themeName} theme)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
