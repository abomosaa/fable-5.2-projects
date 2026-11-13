/**
 * In-memory server harness for lobby/room tests: the real LobbyManager with a
 * manual clock and fake transports. Every frame the server emits is parsed
 * with the shared schemas, so a malformed server message fails the test.
 */
import { testConfig, type ServerConfig } from '../../server/src/config';
import { LobbyManager } from '../../server/src/lobby/manager';
import type { Room } from '../../server/src/lobby/room';
import { MemoryRecordsStore } from '../../server/src/persistence/recordsStore';
import type { Connection } from '../../server/src/transport/connection';
import { silentLogger } from '../../server/src/util/logger';
import {
  PROTOCOL_VERSION,
  decodeSnapshot,
  defaultRoomSettings,
  encodeInput,
  parseServerMessage,
  type RoomSettings,
  type RoomState,
  type ServerMessage,
  type ServerMessageMap,
  type ServerMessageType,
  type Snapshot,
} from '../../shared/protocol';
import { Rng } from '../../shared/sim/rng';
import type { CarInput } from '../../shared/sim/vehicle';

export class FakeClient {
  readonly messages: ServerMessage[] = [];
  readonly frames: Uint8Array[] = [];
  closed: { code: number; reason: string } | null = null;
  conn: Connection;
  youId = '';
  token = '';
  /** Latest room state received. */
  room: RoomState | null = null;
  /** Latest decoded snapshot. */
  snapshot: Snapshot | null = null;
  private readonly snapshots = new Map<number, Snapshot>();
  private seq = 0;

  constructor(
    readonly server: TestServer,
    readonly ip: string,
  ) {
    this.conn = server.manager.connect(
      {
        send: (data) => this.receive(data),
        close: (code, reason) => {
          this.closed = { code, reason };
          // A real socket reports the close back to the server.
          server.manager.disconnect(this.conn);
        },
        bufferedAmount: () => 0,
      },
      ip,
    );
  }

  private receive(data: string | Uint8Array): void {
    if (typeof data !== 'string') {
      this.frames.push(data);
      const decoded = decodeSnapshot(data, (tick) => this.snapshots.get(tick));
      if (decoded.ok) {
        this.snapshot = decoded.value;
        this.snapshots.set(decoded.value.tick, decoded.value);
        if (this.snapshots.size > 100) this.snapshots.delete(this.snapshots.keys().next().value!);
      } else if (decoded.missingBase === undefined) {
        throw new Error(`Server sent an invalid snapshot: ${decoded.error}`);
      }
      return;
    }
    const parsed = parseServerMessage(data);
    if (!parsed.ok) throw new Error(`Server sent an invalid message: ${parsed.error}\n${data}`);
    const message = parsed.value;
    this.messages.push(message);
    if (message.t === 'joined') {
      this.youId = message.youId;
      this.token = message.token;
      this.room = message.room;
    } else if (message.t === 'room') {
      this.room = message.room;
    } else if (message.t === 'left') {
      this.room = null;
    }
  }

  /** Sends any JSON value as a text frame. */
  send(message: unknown): this {
    this.server.manager.handleText(this.conn, JSON.stringify(message));
    return this;
  }

  sendRaw(text: string): this {
    this.server.manager.handleText(this.conn, text);
    return this;
  }

  sendBinary(bytes: Uint8Array): this {
    this.server.manager.handleBinary(this.conn, bytes);
    return this;
  }

  hello(protocol = PROTOCOL_VERSION): this {
    return this.send({ t: 'hello', protocol });
  }

  /** Sends one driving input (with the newest snapshot acknowledged). */
  drive(input: Partial<CarInput> = {}, raceId = this.room?.race?.raceId ?? 0): this {
    // Like the real client, continue from the sequence the server last acknowledged
    // (after a reconnect a fresh client would otherwise send stale numbers).
    this.seq = Math.max(this.seq, this.snapshot?.ackSeq ?? 0) + 1;
    return this.sendBinary(
      encodeInput({
        raceId: raceId & 0xff,
        ackSnapTick: this.snapshot?.tick ?? 0,
        clientTime: 0,
        firstSeq: this.seq,
        inputs: [{ steer: 0, throttle: 0, brake: 0, handbrake: false, reset: false, ...input }],
      }),
    );
  }

  /** Acknowledges the newest snapshot without sending any input (what a spectator does). */
  ack(raceId = this.room?.race?.raceId ?? 0): this {
    return this.sendBinary(encodeInput({ raceId: raceId & 0xff, ackSnapTick: this.snapshot?.tick ?? 0, clientTime: 0, firstSeq: 0, inputs: [] }));
  }

  all<K extends ServerMessageType>(type: K): Array<ServerMessageMap[K]> {
    return this.messages.filter((m): m is ServerMessageMap[K] => m.t === type);
  }

  last<K extends ServerMessageType>(type: K): ServerMessageMap[K] | undefined {
    const list = this.all(type);
    return list[list.length - 1];
  }

  errors(): string[] {
    return this.all('error').map((e) => e.code);
  }

  clear(): this {
    this.messages.length = 0;
    this.frames.length = 0;
    return this;
  }

  /** The socket closes (network failure or the tab was closed). */
  drop(): void {
    this.server.manager.disconnect(this.conn);
  }

  get me(): RoomState['members'][number] | undefined {
    return this.room?.members.find((m) => m.id === this.youId);
  }

  get mySlot(): number {
    return this.room?.race?.cars.find((c) => c.memberId === this.youId)?.slot ?? -1;
  }
}

export class TestServer {
  now = 1_700_000_000_000;
  readonly config: ServerConfig;
  readonly manager: LobbyManager;
  readonly records = new MemoryRecordsStore();
  private ipCounter = 0;
  private tickDebt = 0;

  constructor(overrides: Partial<ServerConfig> = {}) {
    this.config = testConfig({ countdownTicks: 60, cooldownTicks: 30, ...overrides });
    const rng = new Rng(1234);
    this.manager = new LobbyManager(this.config, silentLogger, this.records, () => this.now, () => (rng.next() * 0x100000000) >>> 0);
  }

  /** A connected client that has completed the handshake. */
  client(ip?: string): FakeClient {
    const client = new FakeClient(this, ip ?? `10.1.0.${++this.ipCounter}`);
    client.hello();
    return client;
  }

  /** A connected socket that has not said hello yet. */
  socket(ip?: string): FakeClient {
    return new FakeClient(this, ip ?? `10.1.0.${++this.ipCounter}`);
  }

  /** Advances the clock, running simulation ticks and housekeeping as the real loop would. */
  advance(ms: number): void {
    const end = this.now + ms;
    const tickMs = 1000 / this.config.tickRate;
    let nextHousekeeping = Math.ceil(this.now / 250) * 250;
    while (this.now < end) {
      const step = Math.min(tickMs, end - this.now);
      this.now += step;
      this.tickDebt += step;
      while (this.tickDebt >= tickMs - 1e-9) {
        this.tickDebt -= tickMs;
        this.manager.tick();
      }
      if (this.now >= nextHousekeeping) {
        this.manager.housekeeping();
        nextHousekeeping += 250;
      }
    }
  }

  room(code: string): Room {
    const room = this.manager.rooms.get(code);
    if (!room) throw new Error(`No room ${code}`);
    return room;
  }
}

export function roomSettings(overrides: Partial<RoomSettings> = {}): RoomSettings {
  return { ...defaultRoomSettings('Host'), name: 'Test room', bots: 0, ...overrides };
}

/** Creates a room and returns its host. */
export function hostRoom(server: TestServer, overrides: Partial<RoomSettings> = {}, name = 'Ada'): FakeClient {
  const host = server.client();
  host.send({ t: 'create', name, settings: roomSettings(overrides) });
  if (!host.room) throw new Error(`Room was not created: ${JSON.stringify(host.messages)}`);
  return host;
}

export function joinRoom(server: TestServer, code: string, name: string, spectate = false): FakeClient {
  const client = server.client();
  client.send({ t: 'join', code, name, spectate });
  return client;
}
