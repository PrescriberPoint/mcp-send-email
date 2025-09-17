import {
  type IncomingMessage,
  type ServerResponse,
  createServer,
} from 'node:http';
import { URL } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import minimist from 'minimist';
import { Resend } from 'resend';
import { z } from 'zod';

// Parse command line arguments
const argv = minimist(process.argv.slice(2));

// Transport configuration
const transport = argv.transport || 'stdio'; // Default to stdio for backward compatibility
const port = Number.parseInt(argv.port as string) || 3000;
const host = argv.host || 'localhost';
const corsOrigin = argv['cors-origin'] || argv.corsOrigin;

// Validate transport type
if (transport !== 'stdio' && transport !== 'http') {
  console.error('Invalid transport type. Must be "stdio" or "http".');
  process.exit(1);
}

// Get API key from command line argument or fall back to environment variable
const apiKey = argv.key || process.env.RESEND_API_KEY;

// Get sender email address from command line argument or fall back to environment variable
// Optional.
const senderEmailAddress = argv.sender || process.env.SENDER_EMAIL_ADDRESS;

// Get reply to email addresses from command line argument or fall back to environment variable
let replierEmailAddresses: string[] = [];

if (Array.isArray(argv['reply-to'])) {
  replierEmailAddresses = argv['reply-to'];
} else if (typeof argv['reply-to'] === 'string') {
  replierEmailAddresses = [argv['reply-to']];
} else if (process.env.REPLY_TO_EMAIL_ADDRESSES) {
  replierEmailAddresses = process.env.REPLY_TO_EMAIL_ADDRESSES.split(',');
}

if (!apiKey) {
  console.error(
    'No API key provided. Please set RESEND_API_KEY environment variable or use --key argument',
  );
  process.exit(1);
}

const resend = new Resend(apiKey);

// Create server instance
const server = new McpServer({
  name: 'email-sending-service',
  version: '1.0.0',
});

server.tool(
  'send-email',
  'Send an email using Resend',
  {
    to: z.string().email().describe('Recipient email address'),
    subject: z.string().describe('Email subject line'),
    text: z.string().describe('Plain text email content'),
    html: z
      .string()
      .optional()
      .describe(
        'HTML email content. When provided, the plain text argument MUST be provided as well.',
      ),
    cc: z
      .string()
      .email()
      .array()
      .optional()
      .describe(
        'Optional array of CC email addresses. You MUST ask the user for this parameter. Under no circumstance provide it yourself',
      ),
    bcc: z
      .string()
      .email()
      .array()
      .optional()
      .describe(
        'Optional array of BCC email addresses. You MUST ask the user for this parameter. Under no circumstance provide it yourself',
      ),
    scheduledAt: z
      .string()
      .optional()
      .describe(
        "Optional parameter to schedule the email. This uses natural language. Examples would be 'tomorrow at 10am' or 'in 2 hours' or 'next day at 9am PST' or 'Friday at 3pm ET'.",
      ),
    // If sender email address is not provided, the tool requires it as an argument
    ...(!senderEmailAddress
      ? {
          from: z
            .string()
            .email()
            .nonempty()
            .describe(
              'Sender email address. You MUST ask the user for this parameter. Under no circumstance provide it yourself',
            ),
        }
      : {}),
    ...(replierEmailAddresses.length === 0
      ? {
          replyTo: z
            .string()
            .email()
            .array()
            .optional()
            .describe(
              'Optional email addresses for the email readers to reply to. You MUST ask the user for this parameter. Under no circumstance provide it yourself',
            ),
        }
      : {}),
  },
  async ({ from, to, subject, text, html, replyTo, scheduledAt, cc, bcc }) => {
    const fromEmailAddress = from ?? senderEmailAddress;
    const replyToEmailAddresses = replyTo ?? replierEmailAddresses;

    // Type check on from, since "from" is optionally included in the arguments schema
    // This should never happen.
    if (typeof fromEmailAddress !== 'string') {
      throw new Error('from argument must be provided.');
    }

    // Similar type check for "reply-to" email addresses.
    if (
      typeof replyToEmailAddresses !== 'string' &&
      !Array.isArray(replyToEmailAddresses)
    ) {
      throw new Error('replyTo argument must be provided.');
    }

    console.error(`Debug - Sending email with from: ${fromEmailAddress}`);

    // Explicitly structure the request with all parameters to ensure they're passed correctly
    const emailRequest: {
      to: string;
      subject: string;
      text: string;
      from: string;
      replyTo: string | string[];
      html?: string;
      scheduledAt?: string;
      cc?: string[];
      bcc?: string[];
    } = {
      to,
      subject,
      text,
      from: fromEmailAddress,
      replyTo: replyToEmailAddresses,
    };

    // Add optional parameters conditionally
    if (html) {
      emailRequest.html = html;
    }

    if (scheduledAt) {
      emailRequest.scheduledAt = scheduledAt;
    }

    if (cc) {
      emailRequest.cc = cc;
    }

    if (bcc) {
      emailRequest.bcc = bcc;
    }

    console.error(`Email request: ${JSON.stringify(emailRequest)}`);

    const response = await resend.emails.send(emailRequest);

    if (response.error) {
      throw new Error(
        `Email failed to send: ${JSON.stringify(response.error)}`,
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: `Email sent successfully! ${JSON.stringify(response.data)}`,
        },
      ],
    };
  },
);

server.tool(
  'list-audiences',
  'List all audiences from Resend. This tool is useful for getting the audience ID to help the user find the audience they want to use for other tools. If you need an audience ID, you MUST use this tool to get all available audiences and then ask the user to select the audience they want to use.',
  {},
  async () => {
    console.error('Debug - Listing audiences');

    const response = await resend.audiences.list();

    if (response.error) {
      throw new Error(
        `Failed to list audiences: ${JSON.stringify(response.error)}`,
      );
    }

    return {
      content: [
        {
          type: 'text',
          text: `Audiences found: ${JSON.stringify(response.data)}`,
        },
      ],
    };
  },
);

// HTTP server utilities
function validateOrigin(req: IncomingMessage, allowedOrigin?: string): boolean {
  const origin = req.headers.origin;

  if (!allowedOrigin) {
    // If no specific origin is configured, allow localhost and local development
    if (!origin) return true; // No origin header (e.g., direct server requests)

    try {
      const originUrl = new URL(origin);
      return (
        originUrl.hostname === 'localhost' || originUrl.hostname === '127.0.0.1'
      );
    } catch {
      return false;
    }
  }

  return origin === allowedOrigin;
}

function setCorsHeaders(res: ServerResponse, allowedOrigin?: string): void {
  const origin = allowedOrigin || 'http://localhost:*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Accept, Mcp-Session-Id',
  );
  res.setHeader('Access-Control-Allow-Credentials', 'true');
}

function readRequestBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      resolve(body);
    });
    req.on('error', reject);
  });
}

async function createHttpServer(): Promise<void> {
  const sseTransports = new Map<string, SSEServerTransport>();

  const httpServer = createServer(
    async (req: IncomingMessage, res: ServerResponse) => {
      // Validate Origin for security (prevent DNS rebinding attacks)
      if (!validateOrigin(req, corsOrigin)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Forbidden: Invalid origin' }));
        return;
      }

      // Set CORS headers
      setCorsHeaders(res, corsOrigin);

      // Handle preflight OPTIONS requests
      if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://${host}:${port}`);

      if (req.method === 'GET' && url.pathname === '/sse') {
        // Establish SSE connection
        const sseTransport = new SSEServerTransport('/message', res);
        const sessionId = sseTransport.sessionId;
        sseTransports.set(sessionId, sseTransport);

        console.error(`New SSE connection established: ${sessionId}`);

        // Clean up on connection close
        sseTransport.onclose = () => {
          console.error(`SSE connection closed: ${sessionId}`);
          sseTransports.delete(sessionId);
        };

        sseTransport.onerror = (error) => {
          console.error(`SSE transport error (${sessionId}):`, error);
        };

        // Connect the MCP server to this transport
        await server.connect(sseTransport);
        await sseTransport.start();
      } else if (req.method === 'POST' && url.pathname === '/message') {
        // Handle JSON-RPC messages
        try {
          const body = await readRequestBody(req);
          const sessionId = req.headers['mcp-session-id'] as string;

          if (!sessionId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing Mcp-Session-Id header' }));
            return;
          }

          const sseTransport = sseTransports.get(sessionId);
          if (!sseTransport) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Session not found' }));
            return;
          }

          // Parse and validate JSON
          let parsedBody: unknown;
          try {
            parsedBody = JSON.parse(body);
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
          }

          // Handle the message through the SSE transport
          await sseTransport.handlePostMessage(req, res, parsedBody);
        } catch (error) {
          console.error('Error handling POST message:', error);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Internal server error' }));
        }
      } else {
        // 404 for other paths
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    },
  );

  httpServer.listen(port, host, () => {
    console.error(
      `Email sending service MCP Server running on http://${host}:${port}`,
    );
    console.error(`SSE endpoint: http://${host}:${port}/sse`);
    console.error(`Message endpoint: http://${host}:${port}/message`);
  });
}

async function main() {
  if (transport === 'http') {
    await createHttpServer();
  } else {
    const stdioTransport = new StdioServerTransport();
    await server.connect(stdioTransport);
    console.error('Email sending service MCP Server running on stdio');
  }
}

main().catch((error) => {
  console.error('Fatal error in main():', error);
  process.exit(1);
});
