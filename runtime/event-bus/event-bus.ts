// Baseline section 41 (Agent Activation Policy) + 75 (Event-Driven
// Execution): ajanlar sürekli yoklama (polling) yapmaz; yalnızca ilgili
// olay geldiğinde etkinleşir. Bu basit olay veri yolu, bir dinleyiciyi
// SADECE kayıtlı olduğu olay türü yayınlandığında çağırır — ilgisiz bir
// olay için hiçbir dinleyici tetiklenmez (Proof I, bölüm 306).

export interface FactoryEvent<TPayload = unknown> {
  readonly type: string;
  readonly payload: TPayload;
}

export type EventHandler<TPayload = unknown> = (event: FactoryEvent<TPayload>) => void | Promise<void>;

export class EventBus {
  private readonly handlers = new Map<string, EventHandler[]>();

  on(eventType: string, handler: EventHandler): void {
    const existing = this.handlers.get(eventType) ?? [];
    existing.push(handler);
    this.handlers.set(eventType, existing);
  }

  async emit(event: FactoryEvent): Promise<void> {
    const handlers = this.handlers.get(event.type) ?? [];
    for (const handler of handlers) {
      await handler(event);
    }
  }

  /** Test/introspection amaçlı: bir olay türü için kaç dinleyici kayıtlı. */
  listenerCount(eventType: string): number {
    return this.handlers.get(eventType)?.length ?? 0;
  }
}

/**
 * AGENT_IDLE_MODE = STOPPED (bölüm 41): bir ajan, ilgilendiği olay dışında
 * hiçbir şey yapmaz ve invocationCount'u yalnızca gerçek etkinleşmede artar.
 * Bu, "boşta duran ajanlar kaynak tüketmez" (Proof F) iddiasının ölçülebilir
 * kanıtıdır.
 */
export class EventDrivenAgent {
  private invocationCount = 0;

  constructor(
    private readonly interestedEventType: string,
    private readonly onActivate: (event: FactoryEvent) => void
  ) {}

  get invocations(): number {
    return this.invocationCount;
  }

  /**
   * Register this agent's handler on a bus. The wrapper is itself async and
   * awaits onActivate, so EventBus.emit's sequential "await handler(event)"
   * loop genuinely waits for this agent's full activation (including any
   * async work like cache writes) before dispatching the next event.
   */
  attach(bus: EventBus): void {
    bus.on(this.interestedEventType, async (event) => {
      this.invocationCount++;
      await this.onActivate(event);
    });
  }
}
