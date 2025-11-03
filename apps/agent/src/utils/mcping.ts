/**
 * Minecraft Server List Ping (SLP) Protocol Implementation
 * Used to query server status without authentication
 */

import net from "net";

export interface MinecraftServerStatus {
  online: boolean;
  version?: string;
  protocol?: number;
  players?: {
    online: number;
    max: number;
    sample?: Array<{ name: string; id: string }>;
  };
  description?: string;
  favicon?: string;
  latency?: number;
}

/**
 * Ping a Minecraft server using the Server List Ping protocol
 * @param host Server hostname or IP
 * @param port Server port (default 25565)
 * @param timeout Timeout in milliseconds (default 5000)
 */
export async function pingMinecraftServer(
  host: string = "localhost",
  port: number = 25565,
  timeout: number = 5000
): Promise<MinecraftServerStatus> {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const client = new net.Socket();

    let responseData = Buffer.alloc(0);

    const cleanup = () => {
      client.destroy();
    };

    const timeoutId = setTimeout(() => {
      cleanup();
      resolve({ online: false });
    }, timeout);

    client.on("error", () => {
      clearTimeout(timeoutId);
      cleanup();
      resolve({ online: false });
    });

    client.on("data", (data) => {
      responseData = Buffer.concat([responseData, data]);

      try {
        // Parse response
        let offset = 0;

        // Read packet length
        const { value: packetLength, bytes: lengthBytes } = readVarInt(responseData, offset);
        offset += lengthBytes;

        // Read packet ID
        const { value: packetId } = readVarInt(responseData, offset);
        offset += 1;

        if (packetId !== 0x00) {
          throw new Error("Invalid packet ID");
        }

        // Read JSON length
        const { value: jsonLength, bytes: jsonLengthBytes } = readVarInt(responseData, offset);
        offset += jsonLengthBytes;

        // Read JSON data
        const jsonStr = responseData.slice(offset, offset + jsonLength).toString("utf-8");
        const response = JSON.parse(jsonStr);

        clearTimeout(timeoutId);
        cleanup();

        resolve({
          online: true,
          version: response.version?.name,
          protocol: response.version?.protocol,
          players: {
            online: response.players?.online ?? 0,
            max: response.players?.max ?? 0,
            sample: response.players?.sample ?? [],
          },
          description: typeof response.description === "string"
            ? response.description
            : response.description?.text ?? JSON.stringify(response.description),
          favicon: response.favicon,
          latency: Date.now() - startTime,
        });
      } catch (err) {
        // Not enough data yet, wait for more
      }
    });

    client.connect(port, host, () => {
      // Send handshake packet
      const handshake = createHandshakePacket(host, port);
      client.write(handshake);

      // Send status request packet
      const statusRequest = Buffer.from([0x01, 0x00]);
      client.write(statusRequest);
    });
  });
}

/**
 * Create a handshake packet for the Server List Ping protocol
 */
function createHandshakePacket(host: string, port: number): Buffer {
  const protocolVersion = writeVarInt(47); // Protocol version (-1 works for most versions, 47 is 1.8)
  const hostLength = writeVarInt(host.length);
  const hostBytes = Buffer.from(host, "utf-8");
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port, 0);
  const nextState = writeVarInt(1); // 1 = status

  const data = Buffer.concat([
    Buffer.from([0x00]), // Packet ID
    protocolVersion,
    hostLength,
    hostBytes,
    portBytes,
    nextState,
  ]);

  const packetLength = writeVarInt(data.length);
  return Buffer.concat([packetLength, data]);
}

/**
 * Write a VarInt (variable-length integer)
 */
function writeVarInt(value: number): Buffer {
  const bytes: number[] = [];

  do {
    let temp = value & 0x7F;
    value >>>= 7;
    if (value !== 0) {
      temp |= 0x80;
    }
    bytes.push(temp);
  } while (value !== 0);

  return Buffer.from(bytes);
}

/**
 * Read a VarInt from a buffer
 */
function readVarInt(buffer: Buffer, offset: number): { value: number; bytes: number } {
  let numRead = 0;
  let result = 0;
  let read: number;

  do {
    if (offset + numRead >= buffer.length) {
      throw new Error("VarInt is too short");
    }

    read = buffer[offset + numRead];
    const value = read & 0x7F;
    result |= value << (7 * numRead);

    numRead++;
    if (numRead > 5) {
      throw new Error("VarInt is too big");
    }
  } while ((read & 0x80) !== 0);

  return { value: result, bytes: numRead };
}
