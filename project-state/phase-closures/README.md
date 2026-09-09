# Phase Closure Manifests (Faz Kapanış Belgeleri)

This directory holds one JSON file per phase-closure **attempt** (not just
successful ones), written by `runtime/governance/phase-closure.ts`'s
`attemptPhaseClosure()`. A file here is never hand-edited — it is a durable
record of what was checked, and what the answer was, at the moment someone
(a human or an agent session) tried to close a phase (e.g. `P0`).

File naming: `<phaseId>-<manifestId>.json`.

## Türkçe özet (başlangıç seviyesi)

Bu klasördeki her dosya, bir "faz kapatma denemesi"nin kalıcı kaydıdır —
başarılı olsun ya da olmasın. Bir faz (ör. P0) kapatılmaya çalışıldığında
şu dört şart TAMAMEN sağlanmadıkça kapanış REDDEDİLİR (`outcome: REJECTED`):

1. **Gerçek kanıt dosyaları** gösterilmeli — sadece "testler geçti" demek
   YETERLİ DEĞİLDİR. `verificationEvidenceRefs` alanındaki her yol,
   diskte gerçekten var olan bir dosyaya işaret etmelidir.
2. **Merkezi Değişmez Kural Bekçisi** (Central Invariant Guard) hiçbir
   engelleyici (BLOCKING) ihlal bulmamalıdır.
3. **Uygulama Gerçeklik Matrisi**nde (Implementation Reality Matrix) o faz
   kapsamındaki hiçbir gereksinim BLOCKED durumda olmamalıdır.
4. **Bağımsız bir inceleme** açıkça "CLEAN" (temiz) sonucunu döndürmüş
   olmalıdır — bu, yerel olarak çalıştırılan bir doğrulama paketinin asla
   kendi başına sağlayamayacağı bir şarttır. Bu, bir fazın (ör. P0)
   kendi kendine, sadece yerel testler geçti diye kapanmasını YAPISAL
   olarak engeller.

Bu dört şarttan biri bile eksikse, deneme `REJECTED` olarak kaydedilir ama
YİNE DE bu klasöre yazılır — "neden kapanmadı?" sorusunun cevabı her zaman
diskte durur. Sadece hepsi sağlandığında `outcome: CLOSED` olur ve bu,
`ScopeLock.close()` üzerinden mevcut Karar Defteri'ne (Founder Decision
Ledger) de işlenir.
