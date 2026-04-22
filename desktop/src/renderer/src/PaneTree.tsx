import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import {
  useTabs,
  type LeafNode,
  type PaneNode,
  type SplitNode,
  type Tab,
} from "./store";
import { TerminalPane } from "./TerminalPane";

type FgMap = Record<string, string | undefined>;

export function PaneTree({
  tab,
  isTabActive,
  fg,
}: {
  tab: Tab;
  isTabActive: boolean;
  fg: FgMap;
}) {
  const totalPanes = countLeaves(tab.layout);
  const showHeaders = totalPanes > 1;
  return render(tab, tab.layout, [], isTabActive, fg, showHeaders);
}

function countLeaves(node: PaneNode): number {
  return node.kind === "leaf"
    ? 1
    : countLeaves(node.a) + countLeaves(node.b);
}

function render(
  tab: Tab,
  node: PaneNode,
  path: number[],
  isTabActive: boolean,
  fg: FgMap,
  showHeaders: boolean,
): JSX.Element {
  if (node.kind === "leaf") {
    return (
      <PaneLeaf
        key={node.paneId}
        tab={tab}
        leaf={node}
        isTabActive={isTabActive}
        fgName={fg[node.paneId]}
        showHeader={showHeaders}
      />
    );
  }
  return <SplitBlock key={keyFromPath(path)} node={node} path={path} tab={tab} isTabActive={isTabActive} fg={fg} showHeaders={showHeaders} />;
}

function keyFromPath(path: number[]): string {
  return path.length === 0 ? "root" : path.join("-");
}

function SplitBlock({
  node,
  path,
  tab,
  isTabActive,
  fg,
  showHeaders,
}: {
  node: SplitNode;
  path: number[];
  tab: Tab;
  isTabActive: boolean;
  fg: FgMap;
  showHeaders: boolean;
}) {
  const setSplitRatio = useTabs((s) => s.setSplitRatio);
  const direction = node.direction === "h" ? "horizontal" : "vertical";
  const handleLayout = (sizes: number[]) => {
    if (sizes.length !== 2) return;
    const ratio = Math.max(0, Math.min(1, sizes[0] / 100));
    if (Math.abs(ratio - node.ratio) > 0.002) {
      setSplitRatio(tab.id, [...path], ratio);
    }
  };
  const groupId = `${tab.id}-${keyFromPath(path)}-${direction}`;
  return (
    <PanelGroup
      direction={direction}
      autoSaveId={undefined}
      id={groupId}
      onLayout={handleLayout}
      className="pd-pane-group"
    >
      <Panel defaultSize={node.ratio * 100} minSize={10} order={1}>
        {render(tab, node.a, [...path, 0], isTabActive, fg, showHeaders)}
      </Panel>
      <PanelResizeHandle
        className={`pd-split-handle ${direction === "horizontal" ? "horizontal" : "vertical"}`}
        onDoubleClick={() => setSplitRatio(tab.id, [...path], 0.5)}
      />
      <Panel defaultSize={(1 - node.ratio) * 100} minSize={10} order={2}>
        {render(tab, node.b, [...path, 1], isTabActive, fg, showHeaders)}
      </Panel>
    </PanelGroup>
  );
}

function PaneLeaf({
  tab,
  leaf,
  isTabActive,
  fgName,
  showHeader,
}: {
  tab: Tab;
  leaf: LeafNode;
  isTabActive: boolean;
  fgName?: string;
  showHeader: boolean;
}) {
  const focusPane = useTabs((s) => s.focusPane);
  const closePane = useTabs((s) => s.closePane);
  const focused = tab.focusedPaneId === leaf.paneId;

  const tildeCwd = leaf.cwd.replace(/^\/Users\/[^/]+/, "~");
  const paneActive = isTabActive && focused;

  return (
    <div
      className={`pd-pane ${focused ? "focused" : ""}`}
      data-pane-id={leaf.paneId}
      onMouseDownCapture={() => {
        if (!focused) focusPane(tab.id, leaf.paneId);
      }}
    >
      {showHeader && (
        <div className="pd-pane-header">
          <span className="pd-pane-cwd" title={leaf.cwd}>
            {tildeCwd}
          </span>
          {fgName && (
            <span className="pd-pane-proc" title={`foreground: ${fgName}`}>
              {fgName}
            </span>
          )}
          <button
            className="pd-pane-close"
            onClick={() => closePane(tab.id, leaf.paneId)}
            title="Close pane"
            aria-label="Close pane"
          >
            ×
          </button>
        </div>
      )}
      <div className="pd-pane-body">
        <TerminalPane
          paneId={leaf.paneId}
          cwd={leaf.cwd}
          cmd={leaf.cmd}
          active={paneActive}
        />
      </div>
    </div>
  );
}
