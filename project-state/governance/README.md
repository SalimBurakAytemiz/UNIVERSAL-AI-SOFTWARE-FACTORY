# Governance state (Faz Yönetişim Durumu)

This directory holds the Factory's persisted governance state, written by
`runtime/governance/scope-lock.ts` (`ScopeLock.saveTo()`) and
`runtime/decisions/decision-ledger.ts` (`FounderDecisionLedger.saveTo()`).
It is real, machine-checked state — not prose — produced by actually
running the Central Invariant Guard and Scope Lock against this
repository's own authoritative requirement registry, never hand-written.

- `scope-lock.json` — the current lock state of each tracked phase (`OPEN`
  / `LOCKED_FOR_CLOSURE` / `CLOSED`). Load with `ScopeLock.loadFrom()`.
- `decision-ledger.json` — every governance decision (lock, close, reopen,
  backlog-routing denial) recorded against a phase, in the SAME Founder
  Decision Ledger every other Factory decision uses. Load with
  `FounderDecisionLedger.loadFrom()`.

## Türkçe özet (başlangıç seviyesi)

Bu klasördeki dosyalar, Factory'nin "hangi fazın şu an ne durumda olduğu"
ve "bu duruma nasıl gelindiği" bilgisini KALICI olarak tutar. Örneğin P0
fazı `LOCKED_FOR_CLOSURE` durumundaysa, bu "P0 kapanmaya hazır, ama henüz
KAPANMADI — bağımsız bir inceleme 'CLEAN' (temiz) sonucu vermeden gerçekten
kapanamaz" anlamına gelir. Bu dosyalar elle düzenlenmemelidir — sadece
`ScopeLock`/`FounderDecisionLedger` sınıfları üzerinden, gerçek bir
`InvariantGuard` (Merkezi Değişmez Kural Bekçisi) çalıştırıldıktan sonra
güncellenir.
