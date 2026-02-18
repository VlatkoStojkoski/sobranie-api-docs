# Sobranie.mk API Discovery

Reverse-engineer the undocumented [sobranie.mk](https://www.sobranie.mk) RPC-style web API into a high-quality OpenAPI 3.0 specification.

The API multiplexes many logical methods through a single endpoint (`POST /Routing/MakePostRequest`) using a `MethodName` field. This CLI captures traffic, infers schemas, and lets you classify fields as enums or foreign keys to produce clean, typed specs.

## Quick start

```bash
pnpm install
pnpm start        # Interactive: new session or resume existing
```

## CLI commands

| Command | Description |
|---------|-------------|
| `pnpm start` | Interactive menu: new or resume session |
| `pnpm start -- --action new --har <path> --review-mode auto-scalar` | Fully parameterized non-interactive run |
| `pnpm new` | Create a new session and run the pipeline |
| `pnpm new --har <path>` | Create a session from an existing HAR file (skips recording) |
| `pnpm resume` | Resume an existing session |
| `pnpm sessions` | List all sessions |
| `pnpm test` | Run full test suite |

### Useful CLI options

- `--sessions-dir <path>`: override where sessions are stored (default: `./sessions`)
- `--review-mode <interactive|batch|auto-scalar>`: control suspect classification flow
- `--assume-edited`: in batch mode, continue without confirmation prompt
- `--force-on-validation-failure`: emit even when validation fails (non-interactive fallback)
- `start --action <new|resume>`: skip menu selection
- `resume --latest`: resume newest session without prompt

## Pipeline

```
Record HAR (Dev Proxy) → Extract + Normalize → Infer Schemas (quicktype)
→ Collect Values → Prompt User (enum/FK/scalar)
→ Transform Schemas → Validate → Emit OpenAPI
```

1. **Record** — Dev Proxy captures `POST /Routing/MakePostRequest` traffic to a HAR file.
2. **Extract + Normalize** — Parse HAR, normalize all keys to PascalCase, strip leading `/` from method names, group by `MethodName`.
3. **Infer** — quicktype-core infers JSON Schemas from all request/response samples per method.
4. **Collect Values** — Walk all samples, collect leaf values per key name, detect "suspects" (fields where any value repeats).
5. **Prompt** — For each suspect: classify as scalar, enum, or foreign key. Match or create shared component definitions.
6. **Transform** — Replace classified properties with `$ref` to shared components.
7. **Validate** — Every sample must validate against its schema. Blocks emit until all pass.
8. **Emit** — Multi-file OpenAPI output.

## Sessions

Each run is a session stored in `sessions/{timestamp}/`:

```
sessions/2025-02-16T14-30-00-000Z/
  har/input.har          # Captured HAR
  samples/               # Extracted request/response JSON per method
  decisions.json         # User decisions + shared components
  progress.json          # Current step, undo stack
  openapi/               # Generated spec
    openapi.yaml         # Root (path + schema $refs)
    paths/*.yaml         # One per method
    schemas/*/Request.yaml, Response.yaml
    schemas/shared/*.yaml  # Enums, FK refs
    openapi.bundled.json   # Single-file version
```

Sessions can be resumed at any step. Undo reverts the last enum/FK decision.

## How enum/FK classification works

- **Enum**: closed set of values. Emitted as `{ type: string, enum: [values] }`.
- **Foreign Key**: reference to another entity. Emitted as `{ type: string|integer }` (no values listed).
- **Scalar**: left as quicktype inferred it.

Cross-method reuse: if a field's value set matches or overlaps an existing component, the CLI prompts to reuse or merge.

## Guarantees

- **Never reject observed**: all captured samples validate against emitted schemas.
- **Determinism**: same HAR + same decisions = same spec.
- **Resumable**: sessions persist state at every step.
- **User control**: no automated classification; user decides everything.

## Repository layout

```
src/
  cli/
    index.ts           # Commander CLI + pipeline orchestrator
    session.ts         # Session CRUD, progress, resume
    recording.ts       # Dev Proxy spawn, HAR copy
    prompts.ts         # @inquirer/prompts wrappers
  types.ts             # Shared types
  extract.ts           # HAR parsing + PascalCase normalization + grouping
  infer.ts             # quicktype-core schema inference
  value-registry.ts    # Leaf value collection, suspect detection
  decisions.ts         # Load/save decisions + shared components
  schema-transform.ts  # Inject $ref for enum/FK fields
  validate.ts          # Ajv validation gate
  emit.ts              # Multi-file OpenAPI 3.0 emitter
```

## Dependencies

| Package | Purpose |
|---------|---------|
| commander | CLI structure |
| @inquirer/prompts | Interactive prompts |
| quicktype-core | JSON Schema inference from samples |
| ajv | JSON Schema validation |
| js-yaml | YAML output |
| tsx | TypeScript runner |

## Prerequisites

- Node.js 18+
- [Dev Proxy](https://learn.microsoft.com/en-us/microsoft-cloud/dev/dev-proxy/) for recording (macOS: `brew tap dotnet/dev-proxy && brew install dev-proxy`)
