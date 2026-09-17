#!/usr/bin/env node
/**
 * mobius-mcp: an MCP server that lets an AI agent drive a Sweipe or FlatMobile
 * WordPress site through the theme plugin's `sweipe/v1/agent` REST surface.
 *
 * Environment:
 *   SWEIPE_SITE_URL      https://example.com
 *   SWEIPE_USER          an administrator's login
 *   SWEIPE_APP_PASSWORD  that user's Application Password (WordPress → Users → Profile)
 *   SWEIPE_IMPORT_BUDGET seconds per import step on the server (default 25, max 55)
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SweipeClient, SweipeError, configFromEnv } from './client.js';

const server = new McpServer({ name: 'mobius-mcp', version: '0.1.0' });

let client: SweipeClient | null = null;
function api(): SweipeClient {
  if (!client) client = new SweipeClient(configFromEnv());
  return client;
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean };

function ok(data: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

function fail(e: unknown): ToolResult {
  const msg =
    e instanceof SweipeError
      ? `${e.message}${e.status ? ` (HTTP ${e.status})` : ''}${e.code ? ` [${e.code}]` : ''}`
      : e instanceof Error
        ? e.message
        : String(e);
  return { content: [{ type: 'text', text: msg }], isError: true };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (e) {
    return fail(e);
  }
}

/** Strip the per-page audit and section catalogue from plan/review replies: large and only useful on demand. */
function slim(data: any): any {
  if (!data || typeof data !== 'object') return data;
  const { audit, sections, ...rest } = data;
  if (audit) rest.audit_pages = Array.isArray(audit) ? audit.length : undefined;
  if (sections) rest.section_count = Object.keys(sections).length;
  return rest;
}

// ------------------------------------------------------------------ Status.

server.registerTool(
  'sweipe_status',
  {
    title: 'Site status',
    description:
      'What this WordPress install is (theme, plugin, Elementor, WooCommerce), whether the licence is active, whether AI is enabled and configured, and where the AI site plan stands (planned, built, reviewed). Call this first.',
    inputSchema: {},
  },
  async () => run(() => api().agent('GET', 'status')),
);

server.registerTool(
  'sweipe_list_demos',
  {
    title: 'List demo packages',
    description:
      'The ready-made demo sites this licence can import (slug, name, description, category, required plugins). Use sweipe_import_demo with a slug.',
    inputSchema: { refresh: z.boolean().optional().describe('Bypass the cached list.') },
  },
  async ({ refresh }) => run(() => api().agent('GET', `demos${refresh ? '?refresh=1' : ''}`)),
);

server.registerTool(
  'sweipe_import_demo',
  {
    title: 'Import a demo',
    description:
      'Import one of the demo packages into the site and wait for it to finish (pages, menus, images, settings; products when WooCommerce is active). Existing user pages are never overwritten. Takes one to a few minutes.',
    inputSchema: { slug: z.string().describe('Demo slug from sweipe_list_demos.') },
  },
  async ({ slug }) =>
    run(async () => {
      const start = await api().agent('POST', 'imports', { slug });
      const final = await api().runImport(start.import_id);
      return { started: start, result: final };
    }),
);

server.registerTool(
  'sweipe_import_status',
  {
    title: 'Import progress',
    description: 'Progress of a running or finished import by its import_id.',
    inputSchema: { import_id: z.string() },
  },
  async ({ import_id }) => run(() => api().agent('GET', `imports/${encodeURIComponent(import_id)}`)),
);

// ---------------------------------------------------------------------- AI.

server.registerTool(
  'sweipe_ai_ping',
  {
    title: 'AI service check',
    description:
      'Round trip to the Sweipe AI service: confirms the licence is accepted and returns the credit balance (included monthly credits, used, left, reset date).',
    inputSchema: {},
  },
  async () => run(() => api().agent('POST', 'ai/ping')),
);

server.registerTool(
  'sweipe_ai_library',
  {
    title: 'Site templates',
    description:
      'The templates a site can be planned from (slug, name, what the design looks like, required plugins). Pass a slug as `base` to sweipe_ai_plan, or let the planner pick.',
    inputSchema: {},
  },
  async () => run(() => api().agent('GET', 'ai/library')),
);

server.registerTool(
  'sweipe_ai_get_plan',
  {
    title: 'Current site plan',
    description: 'The stored site plan (pages and their sections), the brief it came from, and when it was built and reviewed.',
    inputSchema: { include_sections: z.boolean().optional().describe('Include the section catalogue (kind and name per section id).') },
  },
  async ({ include_sections }) =>
    run(async () => {
      const data = await api().agent('GET', 'ai/plan');
      return include_sections ? data : slim(data);
    }),
);

server.registerTool(
  'sweipe_ai_plan',
  {
    title: 'Plan a site from a brief',
    description:
      'Turn a one-paragraph business brief into a site plan: pages, and for each page an ordered list of sections chosen from the template library. Costs 1 credit. Review the plan (edit page titles, slugs, add or drop sections) before sweipe_ai_build.',
    inputSchema: {
      brief: z.string().min(10).describe('What the business is, who it serves, what the site must do. A few sentences.'),
      language: z.string().optional().describe('Site language, e.g. "English", "Türkçe", "Deutsch". Defaults to the brief\'s language.'),
      base: z.string().optional().describe('Template slug from sweipe_ai_library to start from. Omit to let the planner choose.'),
    },
  },
  async ({ brief, language, base }) =>
    run(async () => slim(await api().agent('POST', 'ai/plan', { brief, language: language ?? '', base: base ?? '' }))),
);

server.registerTool(
  'sweipe_ai_build',
  {
    title: 'Build the planned site',
    description:
      'Assemble the plan into pages with copy written from the brief and stock photos, then import it into the site and wait for the import to finish. Costs 4 credits. Pass `plan` to build an edited plan; omit it to build the stored one.',
    inputSchema: {
      plan: z.record(z.any()).optional().describe('An edited plan object from sweipe_ai_plan / sweipe_ai_get_plan. Omit to build the stored plan.'),
      import: z.boolean().optional().describe('Import after building (default true). False only downloads the package.'),
    },
  },
  async ({ plan, import: doImport }) =>
    run(async () => {
      const wantImport = doImport !== false;
      const built = await api().agent('POST', 'ai/build', { plan: plan ?? null, import: wantImport });
      if (!wantImport) return built;
      if (built.import_error) throw new SweipeError(`Built, but the import could not start: ${built.import_error}`, 500);
      const final = await api().runImport(built.import_id);
      const { zip_path, ...rest } = built;
      return { build: rest, import: final };
    }),
);

server.registerTool(
  'sweipe_ai_review',
  {
    title: 'Review the built site',
    description:
      'Render every built page, inspect it (empty sections, broken images, missing pages), take phone and desktop screenshots, and have the service judge the result against the brief. Returns a score out of 10, a summary, the changes made to the plan and whether the plan changed. If `changed` is true, call sweipe_ai_build again, then review with mode "fix". Full review costs 5 credits, fix 2 (free when nothing is broken).',
    inputSchema: { mode: z.enum(['full', 'fix']).optional().describe('"full" judges structure against the brief; "fix" only repairs what the inspection found.') },
  },
  async ({ mode }) => run(async () => slim(await api().agent('POST', 'ai/review', { mode: mode ?? 'full' }))),
);

server.registerTool(
  'sweipe_site_from_brief',
  {
    title: 'Site from brief (plan, build, review, rebuild)',
    description:
      'The whole loop in one call: plan from the brief, build and import, full review, and if the review changed the plan, rebuild and run a fix review. About 12 credits and 3–8 minutes. Use the individual tools when the plan should be edited by hand first.',
    inputSchema: {
      brief: z.string().min(10),
      language: z.string().optional(),
      base: z.string().optional().describe('Template slug from sweipe_ai_library.'),
      review: z.boolean().optional().describe('Run the review loop after the first build (default true).'),
    },
  },
  async ({ brief, language, base, review }) =>
    run(async () => {
      const a = api();
      const steps: any[] = [];
      const plan = await a.agent('POST', 'ai/plan', { brief, language: language ?? '', base: base ?? '' });
      steps.push({ step: 'plan', pages: plan.plan?.pages?.map((p: any) => p.slug), credits: plan.credits });
      const built = await a.agent('POST', 'ai/build', { plan: null, import: true });
      if (built.import_error) throw new SweipeError(`Built, but the import could not start: ${built.import_error}`, 500);
      const imported = await a.runImport(built.import_id);
      steps.push({ step: 'build', pages: built.pages, photos: built.photos, import: imported.status, credits: built.credits });
      if (review !== false) {
        const r1 = await a.agent('POST', 'ai/review', { mode: 'full' });
        steps.push({ step: 'review', score: r1.score, summary: r1.summary, changed: r1.changed, changes: r1.changes, credits: r1.credits });
        if (r1.changed) {
          const b2 = await a.agent('POST', 'ai/build', { plan: null, import: true });
          if (!b2.import_error) await a.runImport(b2.import_id);
          const r2 = await a.agent('POST', 'ai/review', { mode: 'fix' });
          steps.push({ step: 'rebuild+fix', score: r2.score, summary: r2.summary, issues: r2.issues, credits: r2.credits });
        }
      }
      const status = await a.agent('GET', 'status');
      return { site: status.site.url, steps, plan: status.plan, credits: status.ai.credits };
    }),
);

server.registerTool(
  'sweipe_ai_set_enabled',
  {
    title: 'Turn AI features on or off',
    description: 'Switch the AI features of the plugin on or off for this site (Sweipe → AI).',
    inputSchema: { enabled: z.boolean() },
  },
  async ({ enabled }) => run(() => api().agent('POST', 'ai/settings', { enabled })),
);

// ------------------------------------------------------------------- Brief.

server.registerTool(
  'sweipe_brief_pages',
  {
    title: 'Pages with editable copy',
    description:
      'Every page, post and the site identity block (id 0: title, tagline, menus) with how many text items each holds, whether a draft is waiting, and whether AI copy has already been applied. Use the ids with sweipe_brief_generate / apply / undo.',
    inputSchema: {},
  },
  async () => run(() => api().agent('GET', 'brief')),
);

server.registerTool(
  'sweipe_brief_pick',
  {
    title: 'Which demos fit a brief',
    description: 'Ask the service which demo packages fit the business brief, with a reason each. Free. Also stores the brief for later copy generation.',
    inputSchema: { brief: z.string().min(10), language: z.string().optional() },
  },
  async ({ brief, language }) => run(() => api().agent('POST', 'brief/pick', { brief, language: language ?? '' })),
);

server.registerTool(
  'sweipe_brief_generate',
  {
    title: 'Draft copy for a page',
    description:
      'Rewrite every text on one page (or the site identity, post_id 0) for the business in the brief, keeping the layout. Returns the draft rows (id, widget, old, new) and stores them; nothing changes on the site until sweipe_brief_apply. 1 credit per page.',
    inputSchema: {
      post_id: z.number().int().describe('Page or post id from sweipe_brief_pages; 0 for site title, tagline and menus.'),
      brief: z.string().min(10),
      language: z.string().optional(),
    },
  },
  async ({ post_id, brief, language }) => run(() => api().agent('POST', 'brief/generate', { post_id, brief, language: language ?? '' })),
);

server.registerTool(
  'sweipe_brief_apply',
  {
    title: 'Apply drafted copy',
    description:
      'Write the stored drafts into the pages, keeping a backup for sweipe_brief_undo. Pass `items` to apply an edited or partial set of rows per page instead of the whole draft.',
    inputSchema: {
      post_ids: z.array(z.number().int()).min(1),
      items: z.record(z.array(z.object({ id: z.string(), new: z.string() }))).optional().describe('post_id → rows to apply; omit to apply the stored draft.'),
    },
  },
  async ({ post_ids, items }) => run(() => api().agent('POST', 'brief/apply', { post_ids, items: items ?? {} })),
);

server.registerTool(
  'sweipe_brief_undo',
  {
    title: 'Undo applied copy',
    description: 'Restore the pre-apply backup of the given pages (all backed-up pages when post_ids is empty).',
    inputSchema: { post_ids: z.array(z.number().int()).optional() },
  },
  async ({ post_ids }) => run(() => api().agent('POST', 'brief/undo', { post_ids: post_ids ?? [] })),
);

// --------------------------------------------------------- Core WordPress.

const SETTINGS_KEYS = ['title', 'description', 'timezone', 'date_format', 'time_format', 'language', 'posts_per_page', 'show_on_front', 'page_on_front', 'page_for_posts'] as const;

server.registerTool(
  'wp_get_settings',
  {
    title: 'Site settings',
    description: 'Core WordPress settings (site title, tagline, timezone, language, front page) via wp/v2/settings.',
    inputSchema: {},
  },
  async () =>
    run(async () => {
      const all = await api().request('GET', 'wp/v2/settings');
      return Object.fromEntries(SETTINGS_KEYS.filter((k) => k in all).map((k) => [k, all[k]]));
    }),
);

server.registerTool(
  'wp_update_settings',
  {
    title: 'Update site settings',
    description: 'Change core WordPress settings: title, description (tagline), timezone (e.g. "Europe/Istanbul"), language (e.g. "tr_TR"), show_on_front ("page"|"posts"), page_on_front, page_for_posts.',
    inputSchema: {
      title: z.string().optional(),
      description: z.string().optional(),
      timezone: z.string().optional(),
      language: z.string().optional(),
      date_format: z.string().optional(),
      time_format: z.string().optional(),
      posts_per_page: z.number().int().optional(),
      show_on_front: z.enum(['page', 'posts']).optional(),
      page_on_front: z.number().int().optional(),
      page_for_posts: z.number().int().optional(),
    },
  },
  async (patch) =>
    run(async () => {
      const body = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const all = await api().request('POST', 'wp/v2/settings', body);
      return Object.fromEntries(SETTINGS_KEYS.filter((k) => k in all).map((k) => [k, all[k]]));
    }),
);

server.registerTool(
  'wp_list_pages',
  {
    title: 'List pages',
    description: 'Published and draft pages with id, title, slug, link and status, for picking front pages and checking an import.',
    inputSchema: { search: z.string().optional(), per_page: z.number().int().min(1).max(100).optional() },
  },
  async ({ search, per_page }) =>
    run(async () => {
      const q = new URLSearchParams({ per_page: String(per_page ?? 50), status: 'publish,draft', _fields: 'id,title,slug,link,status,parent' });
      if (search) q.set('search', search);
      const pages = await api().request('GET', `wp/v2/pages?${q}`);
      return pages.map((p: any) => ({ id: p.id, title: p.title?.rendered ?? '', slug: p.slug, link: p.link, status: p.status, parent: p.parent }));
    }),
);

// ---------------------------------------------------------------------------

async function main() {
  try {
    configFromEnv();
  } catch (e: any) {
    // Keep serving so the client can list tools; every call will return this message.
    process.stderr.write(`mobius-mcp: ${e.message}\n`);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((e) => {
  process.stderr.write(`mobius-mcp: ${e?.message || e}\n`);
  process.exit(1);
});
