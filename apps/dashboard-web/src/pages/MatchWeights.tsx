/**
 * iter30/WS8 Day-1 — `/match-weights` skeleton.
 *
 * Renders shadcn `<Table>` with hardcoded 3-row sample + an "Add row"
 * shadcn `<Button>` (no-op placeholder). Goal: prove that shadcn/Tailwind
 * stack renders alongside the legacy `ui.tsx` page chrome (PageHeader,
 * Panel) without breaking other pages or styles.
 *
 * Wave-2 will swap the hardcoded rows for `match-weights-api.ts`
 * `listRows()` + wire the Add/Edit/Delete dialogs (Radix Dialog primitive
 * already on disk in `components/ui/dialog.tsx`).
 */
import { PageHeader, Panel } from "../components/ui.js"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

type SampleRow = {
  skill: string
  weight: number
  category: "core" | "supporting" | "generic"
}

const SAMPLE_ROWS: SampleRow[] = [
  { skill: "rag", weight: 3.0, category: "core" },
  { skill: "tool calling", weight: 3.0, category: "core" },
  { skill: "python", weight: 0.5, category: "generic" },
]

export function MatchWeights() {
  return (
    <div className="page-stack">
      <PageHeader
        eyebrow="iter30 / WS8"
        title="Match Weights"
        description="Per-role skill weight tables. Day-1 skeleton — Wave 2 wires Firestore CRUD against pa-match-weight-tables."
      />
      <Panel
        title="AI Agent 2026"
        eyebrow="ai-agent-2026"
        actions={
          <Button
            type="button"
            variant="default"
            size="sm"
            onClick={() => {
              // TODO(WS8 Wave 2): open Radix Dialog with add-row form
              // wired to match-weights-api.addRow().
              // eslint-disable-next-line no-console
              console.info("[match-weights] Add row clicked (Wave 2 stub)")
            }}
          >
            Add row
          </Button>
        }
      >
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Skill</TableHead>
              <TableHead className="w-32">Weight</TableHead>
              <TableHead className="w-32">Category</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {SAMPLE_ROWS.map((row) => (
              <TableRow key={row.skill}>
                <TableCell className="font-medium">{row.skill}</TableCell>
                <TableCell>{row.weight.toFixed(1)}</TableCell>
                <TableCell>
                  <span className={`status-badge ${row.category === "core" ? "good" : row.category === "supporting" ? "warn" : "muted"}`}>
                    {row.category}
                  </span>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Panel>
    </div>
  )
}
