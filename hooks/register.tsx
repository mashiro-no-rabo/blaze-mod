import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type {
  BlazeArtifact,
  BlazeChange,
  BlazeDoc,
  BlazeTab,
  BlazeView,
} from "../types";
import {
  LOG_TEMPLATE,
  artifactTitle,
  chunkMarkdown,
  compareTypes,
  field,
  parseFrontmatter,
  parseLog,
  statusColor,
} from "./lib";

const PANE = "blaze";
const TITLE = "Blaze";
const TABS: { tab: BlazeTab; label: string; type: string | null }[] = [
  { tab: "plan", label: "PLAN", type: "plans" },
  { tab: "tickets", label: "TICKETS", type: "tickets" },
  { tab: "diff", label: "DIFF", type: null },
];

const view = atom(
  { plugin: "blaze", key: "view" } as const,
  {
    root: null,
    changes: [],
    error: null,
  } as BlazeView,
);
const selectedChange = atom(
  { plugin: "blaze", key: "selectedChange" } as const,
  null as string | null,
);
const tab = atom({ plugin: "blaze", key: "tab" } as const, "plan" as BlazeTab);
const selectedArtifact = atom(
  { plugin: "blaze", key: "selectedArtifact" } as const,
  null as string | null,
);
const doc = atom(
  { plugin: "blaze", key: "doc" } as const,
  null as BlazeDoc | null,
);

let inFlight: Promise<void> | null = null;
let queued = false;

async function jj($: EngineInterface, args: string[]): Promise<string> {
  const ran = await $.process.run([
    "jj",
    "--ignore-working-copy",
    "--color",
    "never",
    ...args,
  ]);
  if (ran.exitCode !== 0)
    throw new Error(ran.stderr.trim() || `jj exited ${ran.exitCode}`);
  return ran.stdout;
}

async function listDir($: EngineInterface, path: string) {
  try {
    return await $.fs.list(path);
  } catch {
    return [];
  }
}

async function loadArtifacts(
  $: EngineInterface,
  dir: string,
): Promise<BlazeArtifact[]> {
  const types = (await listDir($, dir))
    .filter((entry) => entry.kind === "dir")
    .map((entry) => entry.name)
    .sort(compareTypes);

  const artifacts: BlazeArtifact[] = [];
  for (const type of types) {
    const files = (await listDir($, `${dir}/${type}`))
      .filter((entry) => entry.kind === "file" && /\.md$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    for (const name of files) {
      const path = `${dir}/${type}/${name}`;
      const parsed = parseFrontmatter(await $.fs.read(path).catch(() => ""));
      artifacts.push({
        type,
        name,
        path,
        title: artifactTitle(type, name, parsed),
        status: field(parsed, "status"),
      });
    }
  }
  return artifacts;
}

async function scan($: EngineInterface): Promise<BlazeView> {
  // .blaze lives in the root workspace so every secondary workspace shares the same metadata.
  let root: string;
  try {
    root = (await jj($, ["workspace", "root", "--name", "default"])).trim();
  } catch {
    try {
      root = (await jj($, ["workspace", "root"])).trim();
    } catch (err) {
      return {
        root: null,
        changes: [],
        error: `Not a jj repo: ${(err as Error).message}`,
      };
    }
  }

  const blazeDir = `${root}/.blaze`;
  const dirs = new Set(
    (await listDir($, blazeDir))
      .filter((entry) => entry.kind === "dir")
      .map((entry) => entry.name),
  );

  let log;
  try {
    log = parseLog(
      await jj($, [
        "log",
        "--no-graph",
        "-r",
        "::@ & mutable()",
        "-T",
        LOG_TEMPLATE,
      ]),
    );
  } catch (err) {
    return { root, changes: [], error: (err as Error).message };
  }

  const changes: BlazeChange[] = [];
  for (const entry of log) {
    const artifacts = dirs.has(entry.changeId)
      ? await loadArtifacts($, `${blazeDir}/${entry.changeId}`)
      : [];
    changes.push({ ...entry, artifacts });
  }
  return { root, changes, error: null };
}

function tabType(t: BlazeTab): string | null {
  return TABS.find((x) => x.tab === t)?.type ?? null;
}

function defaultArtifact(
  change: BlazeChange | undefined,
  type: string | null,
): string | null {
  if (!change || type === null) return null;
  return change.artifacts.find((a) => a.type === type)?.path ?? null;
}

function resolveArtifact(
  change: BlazeChange | undefined,
  t: BlazeTab,
  current: string | null,
): string | null {
  const type = tabType(t);
  const hit = change?.artifacts.find((a) => a.path === current);
  if (hit !== undefined && (type === null || hit.type === type))
    return hit.path;
  return defaultArtifact(change, type);
}

async function loadDoc($: EngineInterface, path: string | null) {
  if (path === null) {
    await update($, doc, () => null);
    return;
  }
  const text = await $.fs
    .read(path)
    .catch((err) => `_Could not read ${path}: ${(err as Error).message}_`);
  await update($, doc, () => ({ path, text }));
}

async function refreshOnce($: EngineInterface) {
  const next = await scan($);
  await update($, view, () => next);

  const currentChange = await read($, selectedChange);
  const change =
    next.changes.find((c) => c.changeId === currentChange) ?? next.changes[0];
  await update($, selectedChange, () => change?.changeId ?? null);

  const artifact = resolveArtifact(
    change,
    await read($, tab),
    await read($, selectedArtifact),
  );
  await update($, selectedArtifact, () => artifact);
  await loadDoc($, artifact);
}

function refresh($: EngineInterface): Promise<void> {
  if (inFlight) {
    queued = true;
    return inFlight;
  }
  inFlight = (async () => {
    try {
      do {
        queued = false;
        await refreshOnce($);
      } while (queued);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

async function selectChange($: EngineInterface, changeId: string) {
  await update($, selectedChange, () => changeId);
  const { changes } = await read($, view);
  const artifact = defaultArtifact(
    changes.find((c) => c.changeId === changeId),
    tabType(await read($, tab)),
  );
  await update($, selectedArtifact, () => artifact);
  await loadDoc($, artifact);
}

async function selectTab($: EngineInterface, next: BlazeTab) {
  await update($, tab, () => next);
  const { changes } = await read($, view);
  const changeId = await read($, selectedChange);
  const change = changes.find((c) => c.changeId === changeId) ?? changes[0];
  const artifact = resolveArtifact(
    change,
    next,
    await read($, selectedArtifact),
  );
  await update($, selectedArtifact, () => artifact);
  await loadDoc($, artifact);
}

async function selectArtifact($: EngineInterface, path: string) {
  await update($, selectedArtifact, () => path);
  await loadDoc($, path);
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    await $.command.register({
      name: "blaze",
      description:
        "Show .blaze change metadata for the working copy and its ancestors",
    });
    await refresh($);
    if ((await read($, view)).changes.length > 0)
      void $.ui.open({ id: PANE, title: TITLE });
    return started;
  });

  on("command.run", { command: "blaze" }, async ($) => {
    await refresh($);
    await $.ui.open({ id: PANE, title: TITLE });
    return { text: "Blaze pane opened." };
  });

  on("tool.call", { tool: "Write" }, async ($, e, next) => {
    const ran = await next(e);
    if (e.file_path.includes("/.blaze/")) void refresh($);
    return ran;
  });

  on("tool.call", { tool: "Edit" }, async ($, e, next) => {
    const ran = await next(e);
    if (e.file_path.includes("/.blaze/")) void refresh($);
    return ran;
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const ran = await next(e);
    if (/\bjj\b|\.blaze/.test(e.command)) void refresh($);
    return ran;
  });

  on("turn.complete", async ($, e, next) => {
    const done = await next(e);
    void refresh($);
    return done;
  });

  on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e);
    const { Box, Text, Button, Markdown } = ui;
    // The mobile runtime table carries a Select that draws nothing; its documented table has none.
    const Select =
      e.surface !== "mobile" && "Select" in ui ? ui.Select : undefined;
    const current = await read($, view);
    const changeId = await read($, selectedChange);
    const activeTab = await read($, tab);
    const artifactPath = await read($, selectedArtifact);
    const shown = await read($, doc);

    const refreshButton = (
      <Button key="refresh" label="↻" plain onPress={() => void refresh($)} />
    );

    if (current.error !== null) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text color="error">{current.error}</Text>
          {refreshButton}
        </Box>
      );
    }
    if (current.changes.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>No mutable changes at @.</Text>
          {refreshButton}
        </Box>
      );
    }

    const change =
      current.changes.find((c) => c.changeId === changeId) ??
      current.changes[0];
    if (change === undefined) return <Text dimColor>No change selected.</Text>;
    const artifact = change.artifacts.find((a) => a.path === artifactPath);
    const ofType = (type: string) =>
      change.artifacts.filter((a) => a.type === type);
    const shortId = change.shortId;

    const changePicker =
      Select === undefined ? (
        <Text bold>{label(change)}</Text>
      ) : (
        <Select
          key="change"
          value={change.changeId}
          options={current.changes.map((c) => ({
            value: c.changeId,
            label: label(c),
          }))}
          onSelect={(value: string) => void selectChange($, value)}
        />
      );

    const tabBar = (
      <Box flexDirection="row" gap={1}>
        {TABS.map((t) => {
          const active = t.tab === activeTab;
          const count = t.type === null ? 0 : ofType(t.type).length;
          const text = count > 0 ? `${t.label} ${count}` : t.label;
          // Brackets drawn by hand: the Button chrome pads them as `[ label ]` and can't be coloured.
          return active ? (
            <Text
              key={`tab-${t.tab}`}
              color="suggestion"
              bold
            >{`>${text}<`}</Text>
          ) : (
            <Button
              key={`tab-${t.tab}`}
              label={`[${text}]`}
              plain
              dimColor
              onPress={() => void selectTab($, t.tab)}
            />
          );
        })}
      </Box>
    );

    const header = (
      <Box flexDirection="row" gap={2}>
        {refreshButton}
        {changePicker}
      </Box>
    );
    if (change.artifacts.length === 0) return header;

    const body =
      activeTab === "plan"
        ? renderPlans()
        : activeTab === "tickets"
          ? renderTickets()
          : renderDiff();

    return (
      <Box flexDirection="column" gap={1}>
        {header}
        {tabBar}
        {body}
      </Box>
    );

    function renderPlans() {
      const plans = ofType("plans");
      if (plans.length === 0)
        return <Text dimColor>No plans/ for {shortId}</Text>;
      return (
        <Box flexDirection="column" gap={1}>
          {plans.length > 1 &&
            (Select === undefined ? (
              <Box flexDirection="column">{plans.map(row)}</Box>
            ) : (
              <Select
                key="plan"
                label="PLAN"
                value={
                  artifact?.type === "plans"
                    ? artifact.path
                    : (plans[0]?.path ?? "")
                }
                options={plans.map((p) => ({ value: p.path, label: p.title }))}
                onSelect={(value: string) => void selectArtifact($, value)}
              />
            ))}
          {selectedDoc("plans")}
        </Box>
      );
    }

    function renderTickets() {
      const tickets = ofType("tickets");
      if (tickets.length === 0)
        return <Text dimColor>No tickets/ for {shortId}</Text>;
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">{tickets.map(row)}</Box>
          {selectedDoc("tickets")}
        </Box>
      );
    }

    function renderDiff() {
      return <Text dimColor>Not implemented yet.</Text>;
    }

    function row(a: BlazeArtifact) {
      return (
        <Box key={`row-${a.path}`} flexDirection="row" gap={1}>
          <Text color={a.path === artifactPath ? "suggestion" : undefined}>
            {a.path === artifactPath ? "›" : " "}
          </Text>
          <Button
            key={`open-${a.path}`}
            label={a.title}
            plain
            onPress={() => void selectArtifact($, a.path)}
          />
          {a.status !== null && (
            <Text color={statusColor(a.status)}>[{a.status}]</Text>
          )}
        </Box>
      );
    }

    function selectedDoc(type: string) {
      if (
        artifact === undefined ||
        artifact.type !== type ||
        shown === null ||
        shown.path !== artifact.path
      )
        return null;
      return (
        <Box
          flexDirection="column"
          borderStyle="single"
          borderDimColor
          paddingX={1}
        >
          <Box position="absolute" top={-1} left={0}>
            <Text dimColor>{` ${artifact.type}/${artifact.name} `}</Text>
          </Box>
          {renderDoc(artifact, shown.text)}
        </Box>
      );
    }

    function label(c: BlazeChange): string {
      const desc = c.description || "(no description)";
      return `${c.isWorkingCopy ? "@ " : ""}${c.shortId} ${desc}`;
    }

    function renderDoc(a: BlazeArtifact, text: string) {
      const parsed = parseFrontmatter(text);
      const extra = parsed.fields.filter(
        ([k]) => !(a.type === "tickets" && (k === "title" || k === "status")),
      );
      return (
        <Box flexDirection="column" gap={1}>
          {extra.length > 0 && (
            <Box flexDirection="column">
              {extra.map(([k, v]) => (
                <Text key={`field-${k}`}>
                  <Text dimColor>{k}: </Text>
                  {Array.isArray(v) ? v.join(", ") : v}
                </Text>
              ))}
            </Box>
          )}
          {chunkMarkdown(parsed.body).map((chunk, i) => (
            <Markdown key={`md-${i}`} text={chunk} />
          ))}
        </Box>
      );
    }
  });
};
