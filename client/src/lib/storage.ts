import type { Game } from "@shared/schema";
import { apiRequest } from "./queryClient";

class ClientStorage {
  async updateGame(id: number, updates: Partial<Game>): Promise<Game> {
    const res = await apiRequest("PATCH", `/api/games/${id}`, updates);
    return res.json();
  }
}

export const storage = new ClientStorage();
