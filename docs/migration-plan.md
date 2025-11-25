# Codenames AI – Production Migration Plan

## Current State Assessment
- **Monolithic server entrypoint (`server/routes.ts`)** mixes HTTP handlers, WebSocket orchestration, AI orchestration, and business rules (>2,600 LOC) leading to brittle behaviour and no separation of concerns.
- **Inconsistent shared types** between `shared/schema.ts`, client code, and server logic (e.g. missing `CardType`, divergent `AIModel` unions) produce runtime-only guarantees.
- **Front-end duplication and dead code** (unused ShadCN components, duplicate lobby screens `home.tsx`/`index.tsx`, abandoned `GameView`) hinder maintainability and inflate bundle size.
- **Generated artefacts committed to source** (`dist/`, `rest-express@1.0.0`, stale `routes.ts.bak`) obscure the working tree and complicate deployments.
- **Logging & configuration** rely on scattered `console.log` statements with secrets partially logged, no central error handling strategy, and ad-hoc `.env` loading.

## Target Architecture

### Shared Contracts
- Consolidate domain models in `shared/` with Zod schemas (`Game`, `TurnState`, `DiscussionMessage`, etc.) and generate typed clients for both server and front-end.
- Export explicit enums/types (`AIModel`, `CardRole`, `TeamColor`) from a single source to eliminate drift.

### Server
- Structure as layered modules:
  1. **`server/app.ts`** – Express app wiring, middleware, health checks.
  2. **`server/routes/`** – Feature routers (`games.router.ts`, `ai.router.ts`, `meta.router.ts`, `admin.router.ts`).
  3. **`server/controllers/`** – Thin request/response adapters.
  4. **`server/services/`** – Core domain logic (`GameService`, `DiscussionService`, `MetaDecisionService`).
  5. **`server/providers/`** – AI integrations (`OpenAIProvider`, `AnthropicProvider`, `GeminiProvider`, `BamlOrchestrator`) exposing a uniform interface.
  6. **`server/data/`** – `GameRepository` (in-memory + future Postgres/Neon implementations) and persistence adapters.
  7. **`server/websocket/`** – Dedicated gateway managing rooms, events, rate limiting, and reconnection policy.
- Centralise configuration (`server/config.ts`) and structured logging (`pino` or lightweight wrapper) with environment-guarded secrets.
- Provide integration tests for services and contract tests for routers.

### Front-End (React + Vite)
- Adopt a feature-first layout under `client/src/features/` (`lobby`, `board`, `discussion`, `meta`), with shared hooks in `client/src/shared/hooks`.
- Replace ad-hoc WebSocket management with `useRealtimeGame(gameId)` hook built atop `zustand` or React Query subscriptions for predictable lifecycle management.
- Break massive `pages/game.tsx` into composable containers (`GamePage`, `DiscussionPanel`, `VotePanel`, `GameBoard`).
- Remove unused UI primitives; re-export only the small subset actually needed to keep bundle lean.
- Co-locate styles and component logic, enforce linting/formatting, and add smoke tests with Vitest + React Testing Library.

### Tooling & Operations
- Provide `.env.example`, `docker-compose.dev.yml`, and `Makefile`/`npm scripts` for common workflows (dev, lint, test, build).
- Introduce CI-ready commands (`npm run lint`, `npm run test`, `npm run build`).
- Generate OpenAPI or typed client contract for the REST surface (optional stretch if time allows).

## Migration Phases & Priorities
1. **Stabilise Shared Domain Contracts**
   - Refine `shared/schema.ts` into granular modules with complete typings.
   - Ship lightweight validation utilities for both server and client.
2. **Server Core Extraction**
   - Create `GameService` + `GameRepository` skeleton.
   - Move existing create/get/update/delete logic from `server/routes.ts` into service functions with unit tests.
   - Introduce `server/app.ts` and feature routers; leave legacy routes behind a compatibility wrapper until parity achieved.
3. **WebSocket Gateway Refactor**
   - Lift room management, rate limiting, and message dispatch into `server/websocket/manager.ts`.
   - Define typed events shared with front-end (`shared/events.ts`).
4. **AI Provider Abstraction**
   - Wrap OpenAI/Anthropic/Gemini/Baml usage in provider classes with consistent error handling and rate-limit control.
   - Implement retry/backoff strategy and redact sensitive logging.
5. **Front-End Feature Modularisation**
   - Prune unused components, align to feature-based structure, and replace `GamePage` monolith with smaller components + hooks.
   - Align API calls to new REST/WebSocket contracts and add optimistic UI patterns where appropriate.
6. **Observability & Quality Gates**
   - Install structured logging, request tracing IDs, and environment-aware toggles.
   - Add Vitest unit coverage, Playwright (optional) smoke tests, and CI script placeholders.

Each phase keeps functionality stable while unlocking subsequent refactors. Phase 1–2 are prerequisites for meaningful production hardening; we will start implementing them immediately.
