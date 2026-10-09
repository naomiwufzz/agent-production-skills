# Agent Production Skills

Portable, framework-agnostic skills for building safer and more observable AI agents.

## Included skills

- `production-agent-loop`: production-grade agent loop and tool runtime boundaries
- `production-agent-memory`: governed long-term memory operations and auditing
- `production-agent-observability`: local logs, traces, and metrics for agent runs
- `production-agent-tool-permission`: layered tool permission and safety decisions
- `production-agent-intent`: bounded intent classification, slot filling, and honest exits

Each skill is self-contained and has its own `SKILL.md`, references, and supporting
assets or scripts where needed.

## Layout

```text
skills/
├── production-agent-loop/
├── production-agent-memory/
├── production-agent-observability/
├── production-agent-tool-permission/
└── production-agent-intent/
```

These materials are implementation guides and reference designs. They are not
intended to imply that any referenced third-party project endorses this repository.
