import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ErrorCode,
  McpError
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import SpotifyWebApi from "spotify-web-api-node";
import dotenv from "dotenv";

dotenv.config();

interface Task {
  gid: string;
  name: string;
  resource_type: string;
  resource_subtype: string;
}

interface SpotifyError extends Error {
  statusCode?: number;
}

const requiredEnvVars = [
  'ASANA_ACCESS_TOKEN',
  'SPOTIFY_CLIENT_ID',
  'SPOTIFY_CLIENT_SECRET',
  'SPOTIFY_REFRESH_TOKEN',
  'ASANA_PROJECT_ID'
] as const;

requiredEnvVars.forEach(envVar => {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
});

const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID!,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET!,
  refreshToken: process.env.SPOTIFY_REFRESH_TOKEN!
});

const GeneratePlaylistSchema = z.object({
  taskCount: z.number().default(5).pipe(
    z.number().min(1).max(20)
  ).describe("Number of overdue tasks to consider"),
  playlistLength: z.number().default(10).pipe(
    z.number().min(5).max(50)
  ).describe("Number of songs in the playlist"),
  energyLevel: z.number().default(0.7).pipe(
    z.number().min(0).max(1)
  ).describe("Desired energy level (0.0-1.0)")
});

type GeneratePlaylistArgs = z.infer<typeof GeneratePlaylistSchema>;

const RESOURCE_URIS = {
  OVERDUE_TASKS: "motivation://tasks/overdue",
  LATEST_PLAYLIST: "motivation://playlist/latest"
} as const;

export const createServer = () => {
  const server = new Server(
    {
      name: "motivation-playlist-server",
      version: "1.0.0"
    },
    {
      capabilities: {
        resources: { subscribe: true },
        tools: {},
      }
    }
  );

  let lastGeneratedPlaylist: string | null = null;
  let lastTaskCount: number = 0;

  async function refreshSpotifyToken(): Promise<void> {
    try {
      const data = await spotifyApi.refreshAccessToken();
      spotifyApi.setAccessToken(data.body.access_token);
    } catch (error) {
      console.error("Failed to refresh Spotify token:", error);
      throw new McpError(
        ErrorCode.InternalError,
        "Failed to authenticate with Spotify"
      );
    }
  }

async function getOverdueTasks(limit: number): Promise<Task[]> {
  try {
    const projectId = process.env.ASANA_PROJECT_ID;
    if (!projectId) {
      throw new Error('ASANA_PROJECT_ID is not set.');
    }
    const accessToken = process.env.ASANA_ACCESS_TOKEN;
    if (!accessToken) {
      throw new Error('ASANA_ACCESS_TOKEN is not set.');
    }

    if (typeof limit !== 'number' || limit < 1) {
      throw new Error('Limit must be a positive integer.');
    }

    const url = `https://app.asana.com/api/1.0/tasks?project=${projectId}&limit=${limit}`;
    const response = await fetch(url, {
      headers: {
        'accept': 'application/json',
        'authorization': `Bearer ${accessToken}`
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json();
    const tasks = data.data as Task[];

    return tasks;
  } catch (error) {
    console.error("Failed to fetch Asana tasks:", error);
    throw error;
  }
}

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "generate_motivation_playlist",
          description: "Generate a Spotify playlist based on overdue tasks",
          inputSchema: zodToJsonSchema(GeneratePlaylistSchema)
        }
      ]
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "generate_motivation_playlist") {
      try {
        const numericArgs = {
          taskCount: Number(args?.taskCount ?? 0),
          energyLevel: Number(args?.energyLevel ?? 0),
          playlistLength: Number(args?.playlistLength ?? 0)
        };
        const validatedArgs = GeneratePlaylistSchema.parse(numericArgs);
        await refreshSpotifyToken();

        const tasks = await getOverdueTasks(validatedArgs.taskCount);
        lastTaskCount = tasks.length;

        if (tasks.length === 0) {
          return {
            content: [{
              type: "text",
              text: "No overdue tasks found! Time to celebrate! 🎉"
            }]
          };
        }

        const playlistName = `Motivation Mix: ${tasks.length} Tasks to Crush!`;
        const playlistDescription = `Generated playlist for tasks: ${tasks.map(t => t.name).join(", ")}`;

        const recommendationsResponse = await spotifyApi.getRecommendations({
          target_energy: validatedArgs.energyLevel,
          seed_genres: ["work-out", "pop", "motivation", "electronic"],
          limit: validatedArgs.playlistLength
        });

        const playlistResponse = await spotifyApi.createPlaylist(playlistName, {
          description: playlistDescription,
          public: false
        });

        await spotifyApi.addTracksToPlaylist(
          playlistResponse.body.id,
          recommendationsResponse.body.tracks.map(track => track.uri)
        );

        lastGeneratedPlaylist = playlistResponse.body.external_urls.spotify;

        return {
          content: [{
            type: "text",
            text: `Created motivation playlist! 🎵\n\nTasks to complete:\n${tasks.map(t => `- ${t.name}`).join("\n")}\n\nPlaylist URL: ${lastGeneratedPlaylist}`
          }]
        };

      } catch (error: unknown) {
        if (error instanceof z.ZodError) {
          return {
            content: [{
              type: "text",
              text: `Invalid arguments: ${error.errors.map(e => e.message).join(", ")}`
            }],
            isError: true
          };
        }

        console.error("Error generating playlist:", error);
        return {
          content: [{
            type: "text",
            text: `Error generating playlist: ${error instanceof Error ? error.message : 'Unknown error'}`
          }],
          isError: true
        };
      }
    }

    throw new McpError(
      ErrorCode.MethodNotFound,
      `Unknown tool: ${name}`
    );
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
      resources: [
        {
          uri: RESOURCE_URIS.OVERDUE_TASKS,
          name: "Overdue Tasks",
          mimeType: "application/json",
          description: "List of current overdue tasks"
        },
        {
          uri: RESOURCE_URIS.LATEST_PLAYLIST,
          name: "Latest Generated Playlist",
          mimeType: "application/json",
          description: "Information about the most recently generated playlist"
        }
      ]
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;

    switch (uri) {
      case RESOURCE_URIS.OVERDUE_TASKS: {
        const tasks = await getOverdueTasks(10);
        return {
          contents: [{
            uri,
            mimeType: "application/json",
            text: JSON.stringify(tasks, null, 2)
          }]
        };
      }

      case RESOURCE_URIS.LATEST_PLAYLIST: {
        if (!lastGeneratedPlaylist) {
          throw new McpError(
            ErrorCode.InternalError,
            "No playlist has been generated yet"
          );
        }

        return {
          contents: [{
            uri,
            mimeType: "application/json",
            text: JSON.stringify({
              playlistUrl: lastGeneratedPlaylist,
              taskCount: lastTaskCount,
              generatedAt: new Date().toISOString()
            }, null, 2)
          }]
        };
      }

      default:
        throw new McpError(
          ErrorCode.InvalidRequest,
          `Unknown resource: ${uri}`
        );
    }
  });

  return { server };
};