/**
 * FactorIQ Autonomous QA Bot
 *
 * Uses Anthropic API (api credits) + Playwright directly.
 * Claude drives the browser via tool calls in an agentic loop.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... QA_EMAIL=x QA_PASSWORD=y npx tsx run.ts
 *   QA_HEADLESS=true  → run without visible browser
 *   QA_URL=http://...  → target URL (default: http://localhost:8081)
 */

import Anthropic from "@anthropic-ai/sdk";
import { chromium, Browser, Page } from "playwright";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TARGET_URL = process.env.QA_URL ?? "http://localhost:8081";
const EMAIL = process.env.QA_EMAIL ?? "";
const PASSWORD = process.env.QA_PASSWORD ?? "";
const HEADLESS = process.env.QA_HEADLESS === "true";
const MAX_TURNS = parseInt(process.env.QA_MAX_TURNS ?? "120", 10);

// ── Report setup ────────────────────────────────────────────────────────────
const reportsDir = path.join(__dirname, "reports");
const videosDir = path.join(__dirname, "videos");
fs.mkdirSync(reportsDir, { recursive: true });
fs.mkdirSync(videosDir, { recursive: true });
const reportFile = path.join(reportsDir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.md`);
const reportStream = fs.createWriteStream(reportFile, { flags: "a" });
const log = (text: string) => { process.stdout.write(text); reportStream.write(text); };

// ── Playwright tools ─────────────────────────────────────────────────────────
let browser: Browser;
let page: Page;

async function initBrowser() {
  browser = await chromium.launch({
    headless: HEADLESS,
    args: ["--no-sandbox"],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    recordVideo: { dir: videosDir, size: { width: 1280, height: 800 } },
  });
  page = await context.newPage();
}

const tools: Anthropic.Tool[] = [
  {
    name: "navigate",
    description: "Navigate the browser to a URL",
    input_schema: {
      type: "object" as const,
      properties: { url: { type: "string", description: "Full URL to navigate to" } },
      required: ["url"],
    },
  },
  {
    name: "screenshot",
    description: "Take a screenshot of the current page and return what's visible as a description. Use this to understand the current state of the page.",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "click",
    description: "Click an element on the page by CSS selector or visible text",
    input_schema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector, e.g. 'button[type=submit]'" },
        text: { type: "string", description: "Visible text of the element to click (used if selector not provided)" },
      },
    },
  },
  {
    name: "fill",
    description: "Fill a form input with text. Works reliably with React controlled inputs. Use this for all text/number inputs.",
    input_schema: {
      type: "object" as const,
      properties: {
        selector: { type: "string", description: "CSS selector of the input or textarea" },
        text: { type: "string", description: "Text to fill in" },
      },
      required: ["selector", "text"],
    },
  },
  {
    name: "get_page_content",
    description: "Get the current page URL and visible text content",
    input_schema: { type: "object" as const, properties: {} },
  },
  {
    name: "wait",
    description: "Wait for a specified number of milliseconds or for a selector to appear",
    input_schema: {
      type: "object" as const,
      properties: {
        ms: { type: "number", description: "Milliseconds to wait" },
        selector: { type: "string", description: "Wait for this CSS selector to appear" },
      },
    },
  },
  {
    name: "eval",
    description: "Run JavaScript in the page context and return the result",
    input_schema: {
      type: "object" as const,
      properties: { code: { type: "string", description: "JavaScript to evaluate" } },
      required: ["code"],
    },
  },
  {
    name: "read_file",
    description: "Read a source file from the codebase to understand the implementation",
    input_schema: {
      type: "object" as const,
      properties: { path: { type: "string", description: "File path relative to project root" } },
      required: ["path"],
    },
  },
];

async function runTool(name: string, input: Record<string, unknown>): Promise<string> {
  try {
    switch (name) {
      case "navigate": {
        await page.goto(input.url as string, { waitUntil: "domcontentloaded", timeout: 15000 });
        await page.waitForTimeout(1000);
        return `Navigated to ${input.url}. Current URL: ${page.url()}`;
      }
      case "screenshot": {
        // Return actual image so Claude can see the screen visually
        const buf = await page.screenshot({ type: "png", fullPage: false });
        return `__IMAGE__:${buf.toString("base64")}`;
      }
      case "click": {
        if (input.selector) {
          await page.click(input.selector as string, { timeout: 8000 });
        } else if (input.text) {
          await page.getByText(input.text as string).first().click({ timeout: 8000 });
        }
        await page.waitForTimeout(800);
        return `Clicked. Current URL: ${page.url()}`;
      }
      case "fill": {
        await page.fill(input.selector as string, input.text as string);
        return `Filled "${input.text}" into ${input.selector}`;
      }
      case "get_page_content": {
        const url = page.url();
        const title = await page.title();
        const text = await page.evaluate(() =>
          document.body?.innerText?.slice(0, 3000) ?? ""
        );
        return `URL: ${url}\nTitle: ${title}\n\n${text}`;
      }
      case "wait": {
        if (input.selector) {
          await page.waitForSelector(input.selector as string, { timeout: 10000 });
          return `Selector "${input.selector}" appeared`;
        }
        await page.waitForTimeout((input.ms as number) ?? 1000);
        return `Waited ${input.ms ?? 1000}ms`;
      }
      case "eval": {
        const result = await page.evaluate(input.code as string);
        return JSON.stringify(result, null, 2);
      }
      case "read_file": {
        const fullPath = path.join(__dirname, "..", input.path as string);
        if (!fs.existsSync(fullPath)) return `File not found: ${input.path}`;
        const content = fs.readFileSync(fullPath, "utf-8");
        return content.slice(0, 4000);
      }
      default:
        return `Unknown tool: ${name}`;
    }
  } catch (err) {
    return `Tool error: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log("\n╔════════════════════════════════════════════╗");
  console.log("║    FactorIQ QA Bot — Apex Capital POV     ║");
  console.log("╚════════════════════════════════════════════╝");
  console.log(`Target:    ${TARGET_URL}`);
  console.log(`Login:     ${EMAIL || "(none)"}`);
  console.log(`Headless:  ${HEADLESS}`);
  console.log(`Report:    qa-bot/reports/${path.basename(reportFile)}`);
  console.log(`Video:     qa-bot/videos/`);
  console.log("─".repeat(48));

  log(`# FactorIQ QA Report\n**Date:** ${new Date().toISOString()}\n**Target:** ${TARGET_URL}\n\n`);

  await initBrowser();
  console.log("\nBrowser open. Claude is now testing your app...\n");

  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = `You are an autonomous QA tester for FactorIQ, a PE analytics platform. You are acting as a PE analyst at "Apex Capital Partners" (Fund III, $850M, industrials focus) onboarding for the first time.

Your test plan:
1. Navigate to ${TARGET_URL}, sign in with email "${EMAIL}" password "${PASSWORD}"
2. Explore the home dashboard — note KPIs, news summary, navigation
3. Try uploading portfolio data CSV (use columns: company_name,fund,acquisition_year,revenue_millions,ebitda_millions,sector,status)
4. Create a deal for "MidWest Fasteners Corp" (Industrials, $48M revenue, $9.5M EBITDA, $80M EV, add-on)
5. Run Thesis Fit AI analysis and DD Workplan — check if output renders correctly
6. Test Deal Chat — ask "What are the key risks for a fasteners manufacturer?"
7. Check Portfolio Monitoring dashboard
8. Test adversarial: modify deal URL UUID, upload invalid file type (.exe)
9. Check for console errors using eval: "JSON.stringify(window.__errors || [])"

For each test output: ✅ [PASS], ❌ [FAIL], or ⚠️ [WARN] with details.
End with a summary table and top issues by business impact.

Use screenshot and get_page_content frequently to understand what's on screen before acting.`;

  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content: `Start the QA test. Open ${TARGET_URL} and work through all test phases. Think out loud as you go.`,
    },
  ];

  let turns = 0;
  const startTime = Date.now();

  while (turns < MAX_TURNS) {
    const response = await client.messages.create({
      model: "claude-opus-4-6",
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });

    // Collect assistant message
    messages.push({ role: "assistant", content: response.content });

    // Print text blocks
    for (const block of response.content) {
      if (block.type === "text") {
        log(block.text);
      }
    }

    if (response.stop_reason === "end_turn") break;

    // Handle tool calls
    if (response.stop_reason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type === "tool_use") {
          log(`\n> ${block.name}(${JSON.stringify(block.input)})\n`);
          const result = await runTool(block.name, block.input as Record<string, unknown>);

          // Screenshot returns base64 image — send as vision block
          if (result.startsWith("__IMAGE__:")) {
            const b64 = result.slice("__IMAGE__:".length);
            toolResults.push({
              type: "tool_result",
              tool_use_id: block.id,
              content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } }],
            });
          } else {
            toolResults.push({ type: "tool_result", tool_use_id: block.id, content: result });
          }
        }
      }

      messages.push({ role: "user", content: toolResults });
    }

    turns++;
  }

  // Close browser (saves video)
  await page.context().close();
  await browser.close();

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
  log(`\n\n---\nTotal time: ${elapsed}s | Turns: ${turns}\nReport: ${reportFile}\nVideo: ${videosDir}\n`);
  reportStream.end();

  console.log(`\nDone! Report: qa-bot/reports/${path.basename(reportFile)}`);
  console.log(`Video: qa-bot/videos/`);
}

main().catch((err) => {
  console.error("\n❌ Error:", err.message);
  process.exit(1);
});
