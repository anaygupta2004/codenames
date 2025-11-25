# Codenames AI

> A web-based implementation of the popular word-guessing board game Codenames, enhanced with multiple AI models that can act as teammates. Play with or against various AI models in this cooperative word association game.

## Demo

https://github.com/user-attachments/assets/769ccc9c-82b8-4080-9fec-e602d067189d

 width="640" height="480" controls></video>

---

## Table of Contents

- [Features](#features)
- [Technologies Used](#technologies-used)
- [Installation](#installation)
- [Configuration](#configuration)
- [Running the App](#running-the-app)
- [How to Play](#how-to-play)
- [Game Rules](#game-rules)
- [AI Player Capabilities](#ai-player-capabilities)
- [Data Model](#data-model)
- [Contributing](#contributing)
- [License](#license)

---

## Features

- **Classic Codenames gameplay** in a modern, responsive web UI
- **Multiple AI teammate options**:
  - GPT-4o (OpenAI)
  - Claude 3.5 (Anthropic)
  - Grok 2 (X)
  - Gemini 1.5 Pro (Google)
- AI as **Spymasters** (clue generation) and **Operatives** (discussion & voting)
- **Real-time** team discussion and consensus voting via WebSockets
- **Dynamic game board** with visual feedback for revealed words
- **Turn timers** and **complete history** tracking

## Technologies Used

### Frontend

- **React** with TypeScript
- **Tailwind CSS** for utility-first styling
- **Framer Motion** for smooth animations
- **React Query** for data fetching & caching
- **WebSockets** (ws) for bi-directional real-time updates

### Backend

- **Node.js** with **Express**
- **ws** WebSocket server for real-time communication
- Integrations with **OpenAI**, **Anthropic**, **Google Generative AI**
- In-memory game state via `server/storage.ts`

## Installation

### Prerequisites

- **Node.js** v16 or higher
- **npm** (or yarn)
- API keys for the AI models:
  - `OPENAI_API_KEY`
  - `ANTHROPIC_API_KEY`
  - `GOOGLE_API_KEY`

### Clone & Install

```bash
git clone https://github.com/anaygupta2004/codenames.git
cd codenames
npm install
```

## Configuration

Create a `.env` file in the project root with your API keys:

```env
OPENAI_API_KEY=your_openai_key
ANTHROPIC_API_KEY=your_anthropic_key
GOOGLE_API_KEY=your_google_ai_key
```

## Running the App

```bash
npm run dev
```

The app will be available at `http://localhost:3000`.

## How to Play

1. **Create a Game**: On the home page, configure teams by selecting human or AI players (see `client/src/pages/home.tsx`).
2. **Spymaster Clue**: The spymaster gives a one-word clue and a number indicating how many words relate to it.
3. **Team Discussion**: Operatives (human or AI) chat in real time to suggest words.
4. **Voting**: Team members vote on which word to guess next. Correct guesses allow additional guesses; wrong guesses end your turn.
5. **Reveal**: The board updates to show revealed cards and scores.

## Game Rules

- The board has **25 words**: some red, some blue, some neutral, and **one assassin**.
- Teams take turns: red first, then blue.
- **Spymaster** provides a clue (`word (number)`).
- **Operatives** guess words based on the clue.
  - Correct guesses let you continue up to `number+1` total.
  - Wrong guesses end your turn.
  - Guessing the assassin loses the game immediately.
- First team to reveal **all their words** wins.

## AI Player Capabilities

### Spymasters

- Analyze your team's unrevealed words to craft optimal clues.
- Avoid clues that could lead to assassin or opponent words.
- Take into account game history, scores, and remaining cards.

### Operatives

- Interpret the spymaster's clue and propose guesses.
- Collaborate via discussion; each AI votes for the best word.
- Decide when to end the turn for maximum safety.

## Data Model

Game schema is defined in `shared/schema.ts`:

```ts
import { z } from "zod";

export const insertGameSchema = z.object({
  words: z.array(z.string()),
  redTeam: z.array(z.string()),
  blueTeam: z.array(z.string()),
  neutralWords: z.array(z.string()),
  assassin: z.string(),
  currentTurn: z.enum(["red_turn", "blue_turn"]),
  gameState: z.enum([
    "red_turn",
    "blue_turn",
    "red_win",
    "blue_win",
    "time_up",
  ]),
  redSpymaster: z.string(),
  blueSpymaster: z.string(),
  redPlayers: z.array(z.string()),
  bluePlayers: z.array(z.string()),
  gameDuration: z.number().optional(),
  turnTimeLimit: z.number().optional(),
});
```

## Contributing

Contributions are welcome! Please feel free to:

- Open an issue for bugs or feature requests
- Submit pull requests with improvements
- Follow the [Code of Conduct](CODE_OF_CONDUCT.md)

## License

This project is licensed under the **MIT License**. See [LICENSE](LICENSE) for details.
