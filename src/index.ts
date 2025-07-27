#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ElevenLabsClient } from "elevenlabs";
import { spawn } from "child_process";
import { Readable } from "stream";

// Configuration from environment variables
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "Au8OOcCmvsCaQpmULvvQ";
const DEFAULT_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2";
const DEFAULT_STABILITY = parseFloat(process.env.ELEVENLABS_STABILITY || "0.5");
const DEFAULT_SIMILARITY_BOOST = parseFloat(process.env.ELEVENLABS_SIMILARITY_BOOST || "0.75");
const DEFAULT_STYLE = parseFloat(process.env.ELEVENLABS_STYLE || "0.1");

interface TextToSpeechParams {
  text: string;
  voice_id?: string;
  model_id?: string;
  play_audio?: boolean;
}

class ElevenLabsStreamingMCPServer {
  private server: Server;
  private client: ElevenLabsClient;

  constructor() {
    if (!ELEVENLABS_API_KEY) {
      console.error("ERROR: ELEVENLABS_API_KEY environment variable not set!");
      process.exit(1);
    }

    this.client = new ElevenLabsClient({
      apiKey: ELEVENLABS_API_KEY,
    });

    this.server = new Server(
      {
        name: "elevenlabs-streaming-mcp",
        version: "1.1.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "generate_audio",
          description: "Generate and stream audio from text using ElevenLabs",
          inputSchema: {
            type: "object",
            properties: {
              text: {
                type: "string",
                description: "Text to convert to speech",
              },
              voice_id: {
                type: "string",
                description: `Voice ID to use (default: ${DEFAULT_VOICE_ID})`,
              },
              model_id: {
                type: "string",
                description: `Model ID to use (default: ${DEFAULT_MODEL_ID})`,
              },
              play_audio: {
                type: "boolean",
                description: "Whether to play the audio (default: true)",
              },
            },
            required: ["text"],
          },
        },
        {
          name: "list_voices",
          description: "List available ElevenLabs voices",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ],
    }));

    this.server.setRequestHandler(
      CallToolRequestSchema,
      async (request) => {
        switch (request.params.name) {
          case "generate_audio":
            return await this.generateAudio(request.params.arguments as unknown as TextToSpeechParams);
          case "list_voices":
            return await this.listVoices();
          default:
            throw new Error(`Unknown tool: ${request.params.name}`);
        }
      }
    );
  }

  private async generateAudio(params: TextToSpeechParams) {
    const {
      text,
      voice_id = DEFAULT_VOICE_ID,
      model_id = DEFAULT_MODEL_ID,
      play_audio = true,
    } = params;

    try {
      console.error(`[ElevenLabs] Generating audio for: "${text.substring(0, 50)}..."`);

      // Create audio stream
      const audioStream = await this.client.textToSpeech.convert(voice_id, {
        text,
        model_id,
        voice_settings: {
          stability: DEFAULT_STABILITY,
          similarity_boost: DEFAULT_SIMILARITY_BOOST,
          style: DEFAULT_STYLE,
        },
      });

      // Stream directly to ffplay if requested
      if (play_audio) {
        const ffplay = spawn('ffplay', [
          '-f', 'mp3',      // Input format
          '-i', '-',        // Read from stdin
          '-nodisp',        // No display window
          '-autoexit',      // Exit when done
          '-loglevel', 'quiet' // Suppress output
        ]);

        // Convert web stream to Node.js stream and pipe to ffplay
        const nodeStream = Readable.from(audioStream);
        nodeStream.pipe(ffplay.stdin);

        // Handle ffplay process events
        ffplay.on('error', (error) => {
          console.error('[ElevenLabs] ffplay error:', error.message);
        });

        ffplay.on('close', (code) => {
          if (code === 0) {
            console.error('[ElevenLabs] Audio playback completed');
          } else {
            console.error(`[ElevenLabs] ffplay exited with code ${code}`);
          }
        });

        // Wait for streaming to complete
        await new Promise<void>((resolve, reject) => {
          nodeStream.on('end', () => {
            ffplay.stdin.end();
            resolve();
          });
          nodeStream.on('error', reject);
        });
      } else {
        // If not playing, just consume the stream
        const nodeStream = Readable.from(audioStream);
        for await (const _ of nodeStream) {
          // Consume stream
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Audio generated and ${play_audio ? 'played' : 'streamed'} successfully!`,
          },
        ],
      };
    } catch (error) {
      console.error("[ElevenLabs] Error generating audio:", error);
      throw new Error(`Audio generation failed: ${error}`);
    }
  }

  private async listVoices() {
    try {
      const voices = await this.client.voices.getAll();
      
      const voiceList = voices.voices.map((voice: any) => ({
        id: voice.voice_id,
        name: voice.name,
        category: voice.category,
        description: voice.description,
      }));

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(voiceList, null, 2),
          },
        ],
      };
    } catch (error) {
      throw new Error(`Failed to list voices: ${error}`);
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("[ElevenLabs] Streaming MCP Server v1.1.0 running...");
    console.error(`[ElevenLabs] Voice ID: ${DEFAULT_VOICE_ID}`);
    console.error(`[ElevenLabs] Model ID: ${DEFAULT_MODEL_ID}`);
  }
}

const server = new ElevenLabsStreamingMCPServer();
server.run().catch(console.error);