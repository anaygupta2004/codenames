# LinguisticCodenames Development Guide

## Build Commands
- `npm run dev` - Start development server
- `npm run build` - Build the project
- `npm run start` - Start production server
- `npm run check` - Run TypeScript type checking

## Code Style Guidelines
- **Imports**: Group imports by type (React, third-party, local). Use absolute imports with aliases (`@/*` for client and `@shared/*` for shared).
- **Typing**: Use TypeScript with strict mode. Define interfaces/types in shared/schema.ts when used across components.
- **Error Handling**: Use try/catch with proper logging. In async functions, handle fetch errors explicitly.
- **Naming**: Use camelCase for variables/functions, PascalCase for components/classes, UPPER_CASE for constants.
- **Components**: React components should be functional with hooks. Use React.useState and useEffect for state management.
- **BAML Files**: Used for AI prompt engineering - follow existing patterns when modifying.
- **API Services**: For AI integrations, use structured error handling with fallbacks for failed responses.

## Project Structure
- `client/`: React frontend with components, hooks, and pages
- `server/`: Express backend with routes and services
- `shared/`: Shared types and utilities
- `baml_src/`: AI prompt engineering definitions
- `baml_client/`: Generated AI client code (do not edit directly)