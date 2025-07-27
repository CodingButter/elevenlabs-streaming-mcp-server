#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { ElevenLabsClient } from "elevenlabs";
import * as fs from "fs";
import * as path from "path";
import { exec } from "child_process";
import { promisify } from "util";
import { Readable } from "stream";

const execAsync = promisify(exec);

// Configuration from environment variables
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY;
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || "Au8OOcCmvsCaQpmULvvQ";
const DEFAULT_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || "eleven_flash_v2";
const DEFAULT_STABILITY = parseFloat(process.env.ELEVENLABS_STABILITY || "0.5");
const DEFAULT_SIMILARITY_BOOST = parseFloat(process.env.ELEVENLABS_SIMILARITY_BOOST || "0.75");
const DEFAULT_STYLE = parseFloat(process.env.ELEVENLABS_STYLE || "0.1");
const OUTPUT_DIR = process.env.ELEVENLABS_OUTPUT_DIR || "output";

interface TextToSpeechParams {
  text: string;
  voice_id?: string;
  model_id?: string;
  output_format?: string;
  stream?: boolean;
  play_audio?: boolean;
}

class ElevenLabsStreamingMCPServer {
  private server: Server;
  private client: ElevenLabsClient;
  private jobCounter: number = 0;

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
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    this.setupHandlers();
    this.ensureOutputDirectory();
  }

  private ensureOutputDirectory() {
    const outputPath = path.resolve(OUTPUT_DIR);
    if (!fs.existsSync(outputPath)) {
      fs.mkdirSync(outputPath, { recursive: true });
    }
  }

  private setupHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "generate_audio",
          description: "Generate audio from text using ElevenLabs with streaming support",
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
                description: "Whether to play the audio after generation (default: true)",
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
      console.error(`Generating audio for text: "${text.substring(0, 50)}..."`);

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

      // Generate filename
      const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "_").split(".")[0];
      const filename = `elevenlabs_${timestamp}_${this.jobCounter++}.mp3`;
      const filepath = path.join(OUTPUT_DIR, filename);

      // Convert ReadableStream to Node.js stream and save
      const nodeStream = Readable.from(audioStream);
      const writeStream = fs.createWriteStream(filepath);
      
      await new Promise<void>((resolve, reject) => {
        nodeStream.pipe(writeStream);
        writeStream.on("finish", () => resolve());
        writeStream.on("error", reject);
      });

      console.error(`Audio saved to: ${filepath}`);

      // Play audio if requested
      if (play_audio) {
        try {
          await execAsync(`ffplay -nodisp -autoexit "${filepath}"`);
          console.error("Audio playback completed");
        } catch (playError) {
          console.error("Failed to play audio:", playError);
        }
      }

      return {
        content: [
          {
            type: "text",
            text: `Audio generated successfully!\nFile: ${filename}\nPath: ${filepath}`,
          },
        ],
      };
    } catch (error) {
      console.error("Error generating audio:", error);
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
    console.error("ElevenLabs Streaming MCP Server running...");
    console.error(`Voice ID: ${DEFAULT_VOICE_ID}`);
    console.error(`Model ID: ${DEFAULT_MODEL_ID}`);
    console.error(`Output directory: ${OUTPUT_DIR}`);
  }
}

const server = new ElevenLabsStreamingMCPServer();
server.run().catch(console.error);