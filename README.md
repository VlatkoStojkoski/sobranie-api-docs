# Sobranie.mk API Discovery

Reverse-engineer the undocumented [sobranie.mk](https://www.sobranie.mk) RPC-style web API into a high-quality OpenAPI 3.0 specification.

The API multiplexes many logical methods through a single endpoint (`POST /Routing/MakePostRequest`) using a `MethodName` field. This CLI captures traffic, infers schemas, and lets you classify fields (enum/fk/foreign-value/source roles) to produce clean, typed specs with relationship metadata.

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
→ Collect Values (scoped by method+side+path+field) → Prompt User
→ Transform Schemas → Validate → Emit OpenAPI
```

1. **Record** — Dev Proxy captures `POST /Routing/MakePostRequest` traffic to a HAR file.
2. **Extract + Normalize** — Parse HAR, normalize all keys to PascalCase, strip leading `/` from method names, group by `MethodName`.
3. **Infer** — quicktype-core infers JSON Schemas from all request/response samples per method.
4. **Collect Values** — Walk all samples and collect leaf values per scoped field key:
   `method::request|response::parentPath::fieldName`.
5. **Prompt** — For each suspect, classify as:
   `scalar`, `enum`, `fk`, `foreign_value`, `index_source`, or `value_source`.
   You can go back during prompting to undo the previous field.
6. **Relationship checks** — Detect duplicate source declarations (hard gate) and unresolved refs (warnings).
7. **Transform** — Inject `$ref` and `x-relationship` / `x-model-source` metadata.
8. **Validate** — Every sample must validate against its schema. Blocks emit until all pass (unless forced).
9. **Emit** — Multi-file OpenAPI output.

## Sessions

Each run is a session stored in `sessions/{timestamp}/`:

```
sessions/2025-02-16T14-30-00-000Z/
  har/input.har          # Captured HAR
  samples/               # Extracted request/response JSON per method
  decisions.json         # User decisions + shared components
  relationship-conflicts.json   # Temporary conflict file (only when source conflicts exist)
  progress.json          # Current step, undo stack
  openapi/               # Generated spec
    openapi.yaml         # Root (path + schema $refs)
    paths/*.yaml         # One per method
    schemas/*/Request.yaml, Response.yaml
    schemas/shared/*.yaml  # Enums, FK refs
    openapi.bundled.json   # Single-file version
```

Sessions can be resumed at any step.
During interactive prompting you can undo/go back to the previous field.
Relationship warnings are saved in `progress.json`.

## Classification Kinds

- **Scalar**: left as quicktype inferred it.
- **Enum**: closed set of values.
- **Foreign Key (`fk`)**: references a global field definition (e.g. `Committee.Id`).
- **Foreign Value (`foreign_value`)**: references a global resolved/display field definition (e.g. `Committee.Title`).
- **Index Source (`index_source`)**: marks the canonical source field for an `fk` definition.
- **Value Source (`value_source`)**: marks the canonical source field for a `foreign_value` definition.

Field IDs are editable and typically use dot notation, e.g. `Committee.Id`, `Committee.Title`.
Different scoped fields can intentionally point to the same field ID.
If multiple sources are marked for the same field ID, emit is blocked until resolved.

## Relationship Metadata

- Reference fields emit:
  - `x-relationship: { role: "fk" | "foreign_value", field: "<FieldId>" }`
- Source fields emit:
  - `x-relationship: { role: "source", field: "<FieldId>" }`
  - `x-model-source: { role: "source", field: "<FieldId>" }`

Unresolved forward refs are allowed (emit continues) but warnings are printed and stored in `progress.json`.

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
  value-registry.ts    # Leaf value collection + scoped suspect detection
  scoped-field.ts      # Scoped decision key helpers
  decisions.ts         # Load/save decisions + shared components
  relationships.ts     # Relationship conflict/warning analysis
  schema-transform.ts  # Inject $ref + x-relationship metadata
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
| jsonpath-plus | Path-aware leaf extraction for scoped field keys |
| tsx | TypeScript runner |

## Prerequisites

- Node.js 18+
- [Dev Proxy](https://learn.microsoft.com/en-us/microsoft-cloud/dev/dev-proxy/) for recording (macOS: `brew tap dotnet/dev-proxy && brew install dev-proxy`)
