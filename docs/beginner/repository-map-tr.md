# Depo Haritası (Repository Map)

Bu belge, programlama geçmişi olmayan biri için bile bu deponun neyi nerede
sakladığını açıklamak amacıyla yazılmıştır (bkz. Baseline bölüm 282). Her
önemli klasör için şu sorular yanıtlanır: **Nedir? Ne işe yarar? Kim
kullanır? Hangi sistemlerle ilişkilidir? Burada hangi kod bulunur? Yanlış
değiştirilirse ne etkilenebilir?**

Bu harita, yapı önemli ölçüde değiştiğinde güncel tutulmalıdır (bölüm 282).

---

## `specification/`

**Nedir?** Kurucunun (`@SalimBurakAytemiz`) sağladığı, projenin tüm
vizyonunu anlatan "Baseline V1" belgesinin saklandığı yer.

**Ne işe yarar?** Bu belge, projenin "ne olmaya söz verdiğini" tanımlar.
Kod değişebilir ama bu belge, Kurucu onayı olmadan sessizce değiştirilmez.

**Kim kullanır?** Her yeni geliştirme oturumu (insan ya da yapay zekâ
ajanı), işe başlamadan önce burayı okumalıdır.

**Hangi sistemlerle ilişkilidir?** `specification/requirements/` altındaki
kayıtlar buradaki bölümlere referans verir (`source_baseline` alanı).

**Burada hangi kod bulunur?** Kod yoktur — sadece Markdown ve YAML
belgeleri (`UNIVERSAL-AI-SOFTWARE-FACTORY-BASELINE-V1.md`, `BASELINE.md`,
`CHANGELOG.md`, `requirements/`).

**Yanlış değiştirilirse ne etkilenebilir?** Ana belgenin (baseline) içeriği
zayıflatılır veya silinirse, projenin "tek doğruluk kaynağı" bozulur ve
geçmişe dönük izlenebilirlik kaybolur.

---

## `specification/requirements/`

**Nedir?** Baseline belgesindeki gereksinimlerin makine tarafından
okunabilir (YAML) hâli; her birinin sabit bir kimliği vardır (örn.
`UASF-REQ-0027`).

**Ne işe yarar?** "Bu özellik gerçekten çalışıyor mu, yoksa sadece
belgede mi yazıyor?" sorusuna kanıta dayalı cevap verir. `factory baseline
status` komutu bu dosyalardan hesaplama yapar.

**Kim kullanır?** `runtime/cli/commands/baseline-status.ts`, CI'daki
`npm run validate:requirements` komutu, ve ilerlemeyi takip eden herkes.

**Hangi sistemlerle ilişkilidir?** `schemas/requirement.schema.json` ile
doğrulanır.

**Burada hangi kod bulunur?** Kod yok, sadece `.yml` veri dosyaları ve bir
`README.md`.

**Yanlış değiştirilirse ne etkilenebilir?** Bir gereksinimin durumunu
(`status`) kanıt olmadan "tamamlandı" yapmak, "kanıtsız iddia yok"
ilkesini (bölüm 303) doğrudan ihlal eder ve CI'daki şema doğrulaması bunu
yakalayamayabilir — bu yüzden `implementation_refs`/`test_refs` alanları
gerçek dosyalara işaret etmelidir.

---

## `schemas/`

**Nedir?** Gereksinim kayıtları ve model kayıtları gibi veri yapılarının
JSON Schema tanımları.

**Ne işe yarar?** Geçersiz/eksik veri, sessizce kabul edilmek yerine
reddedilir ("fail closed", bölüm 280).

**Kim kullanır?** `scripts/validate-requirements.mjs` ve ileride model
kayıt defteri doğrulaması.

**Yanlış değiştirilirse ne etkilenebilir?** Şema gevşetilirse, hatalı veya
eksik kayıtlar fark edilmeden depoya girebilir.

---

## `runtime/`

**Nedir?** Factory çekirdeğinin (P0) gerçek TypeScript kaynak kodu.

**Ne işe yarar?** Baseline'ın "sadece belge değil, gerçekten çalışan bir
sistem" talebini karşılayan kısımdır.

**Kim kullanır?** `npm test`, `npm run build`, ve `runtime/cli/index.js`
üzerinden çalıştırılan `factory` komutu.

### Alt klasörler

- **`runtime/policy-engine/`** — Her eylemi ALLOW/DENY/APPROVAL_REQUIRED
  olarak sınıflandıran karar motoru ve insan onay iş akışı
  (`approval.ts`). **Dikkat:** Risk seviyesi 5 olan eylemlerin asla
  otomatik onaylanmaması burada garanti edilir — bu dosyayı değiştirmek,
  üretim güvenliğini doğrudan etkiler.
- **`runtime/models/`** — Model kayıt defteri (`registry.ts`), sağlayıcı
  soyutlaması (`gateway.ts`), sahte/test sağlayıcısı
  (`providers/mock-provider.ts`) ve "en ucuz yeterli modeli seç"
  yönlendiricisi (`router.ts`).
- **`runtime/cost/`** ve **`runtime/budget/`** — Harcama takibi ve bütçe
  tavanları. Tavan aşılmadan ÖNCE harcamayı durdurur.
- **`runtime/event-bus/`** — Ajanların sürekli çalışmak yerine yalnızca
  ilgili olayda etkinleşmesini sağlayan olay veri yolu.
- **`runtime/cache/`** — Daha önce hesaplanmış geçerli sonuçların tekrar
  hesaplanmasını önleyen önbellek.
- **`runtime/workers/`** ve **`runtime/scheduler/`** — İşçi (worker) kayıt
  defteri ve "en küçük yeterli işçiyi seç" zamanlayıcısı (örn. GPU
  gerektirmeyen bir iş için GPU işçisi seçilmez).
- **`runtime/audit/`** — Politika kararlarının değiştirilemez (hash
  zincirli) kayıt defteri.
- **`runtime/telemetry/`** — Yapılandırılmış log kaydı; şifre/anahtar gibi
  alanları otomatik olarak gizler.
- **`runtime/cli/`** — `factory` komut satırı aracının giriş noktası ve
  komutları (`doctor`, `baseline status`, `routing explain`).
- **`runtime/capability-gateway/`** — Politika motorunu atlayan bir yol
  bırakmayan tek geçiş noktası: `authorize()` çağrılmadan hiçbir eylemin
  gerçek kodu (`execute`) çalıştırılmaz.
- **`runtime/sandbox/`** — Yol sınırlama (`assertWithinRoot`, `../` ile
  kaçışı engeller) ve zaman aşımı (`withTimeout`) koruması.
- **`runtime/project-isolation/`** — Bir projenin başka bir projenin
  verisine varsayılan olarak erişememesini sağlayan depo.
- **`runtime/project-os/`** — Bir proje için izole dizin yapısını
  (`project-definition/`, `requirements/`, `decisions/` vb.) oluşturan
  betik.
- **`runtime/project-genome/`** — Proje Genome nesnelerini
  `schemas/project-genome.schema.json`'a göre doğrulayan yükleyici.
- **`runtime/discovery/`** — Kurucu fikirlerini netleştirirken hangi
  soruların sorulacağını (CRITICAL/IMPORTANT/OPTIONAL/DERIVABLE) belirler.
- **`runtime/decisions/`** — Kurucu kararlarını, geçmişi silmeden
  (SUPERSEDED işaretleyerek) izleyen karar defteri.
- **`runtime/assumptions/`** — Varsayımları izler; YÜKSEK etkili bir
  varsayım, açık bir Kurucu onayı olmadan kabul edilemez.
- **`runtime/technology-registry/`** ve
  **`runtime/business-capability-registry/`** — Teknoloji ve iş yeteneği
  kayıt defterleri (FORBIDDEN/DEPRECATED teknolojiler asla önerilmez).
- **`runtime/organization-composer/`** — Proje ailesine ve gerekli
  yeteneklere göre minimum gerekli takımları, HER birinin neden
  etkinleştirildiğini kaydederek oluşturur.
- **`runtime/requirements-traceability/`** — Gereksinim kayıt defterindeki
  her kaydın iddia ettiği durumun (status) gerçek kanıtlarla desteklenip
  desteklenmediğini denetler (`factory trace requirement`).
- **`runtime/artifacts/`** — Kod, doküman, ekran görüntüsü gibi üretilen
  çıktıların sınıflandırılmış kaydı.
- **`runtime/service-catalog/`** — Servis/entegrasyon kaydı; sahibi
  olmayan (owner alanı boş) servisleri tespit eder (bölüm 127).
- **`runtime/state/`** — Sadece bellekte değil, gerçekten diske yazan
  kalıcı durum katmanı (`FileStateStore`). Karar defteri ve varsayım
  kaydı artık bunu kullanarak süreç yeniden başlasa bile kaybolmuyor.
- **`runtime/project-lifecycle/`** — P0'ın uçtan uca boru hattı:
  Gereksinim İzlenebilirliği -> Project Genome -> Organization Composer ->
  Project OS (Capability Gateway üzerinden) -> Maliyet/Model Yönlendirme
  -> Kalıcı Durum. Ayrı ayrı test edilmiş parçaların GERÇEKTEN birlikte
  çalıştığının kanıtı `proofs/p0-integrated-flow/` altındadır.

**Yanlış değiştirilirse ne etkilenebilir?** `policy-engine` veya `budget`
içindeki bir hata, gerçek bir dağıtımda maliyet kontrolünün veya insan
onayı zorunluluğunun devre dışı kalmasına yol açabilir — bu klasörler
`CODEOWNERS` içinde özel olarak korunur.

---

## `proofs/`

**Nedir?** Baseline'ın açıkça isimlendirdiği senaryoları (örn. "bütçe
tavanı kaçak harcamayı durdurur") doğrulayan test dosyaları.

**Ne işe yarar?** Birim testlerinden ayrı olarak, "bu spesifik iddia
kanıtlanmış mı?" sorusuna doğrudan cevap verir (bölüm 305-307).

**Kim kullanır?** `npm test` bunları da çalıştırır.

**Yanlış değiştirilirse ne etkilenebilir?** Bir kanıt testi zayıflatılır
veya silinirse, ilgili iddia artık doğrulanamaz hale gelir.

---

## `scripts/`

**Nedir?** Depo bakımı için bağımsız Node.js betikleri.

**Ne işe yarar?**
- `secret-scan.mjs` — Depoya yanlışlıkla gerçek bir sır/anahtar
  eklenip eklenmediğini kontrol eder (harici bir araca ihtiyaç duymadan).
- `validate-requirements.mjs` — Gereksinim kayıtlarının şemaya uygun ve
  kimliklerinin benzersiz olduğunu doğrular.

**Yanlış değiştirilirse ne etkilenebilir?** `secret-scan.mjs`'nin
zayıflatılması, gerçek bir sırrın fark edilmeden herkese açık depoya
girmesine izin verebilir.

---

## `.github/workflows/ci.yml` ve `.github/CODEOWNERS`

**Nedir?** Her push/PR'da otomatik çalışan kontrol zinciri (lint, tip
kontrolü, derleme, testler, gereksinim doğrulama, sır taraması) ve kritik
klasörlerin sahiplik tanımı.

**Yanlış değiştirilirse ne etkilenebilir?** CI zayıflatılırsa, hatalı veya
güvensiz bir değişiklik fark edilmeden `main` dalına girebilir.

---

## `project-state/current.yml`

**Nedir?** Kalıcı (durable) oturum durumu — hangi aşamada olunduğu, hangi
kilometre taşlarının tamamlandığı, bir sonraki adımın ne olduğu (bölüm
277).

**Ne işe yarar?** Bir çalışma oturumu yarıda kesilirse, bir sonraki oturum
baştan başlamak yerine kaldığı yerden devam edebilir.

**Yanlış değiştirilirse ne etkilenebilir?** Yanlış/eski bir durum, bir
sonraki oturumun tamamlanmış işi tekrar yapmasına veya eksik bir adımı
atlamasına yol açabilir.

---

## Kök dizindeki belgeler

- **`README.md`** — Projeye genel bakış ve hızlı başlangıç (İngilizce).
- **`CLAUDE.md`** / **`AGENTS.md`** — Bu depoda çalışan yapay zekâ
  ajanları için kurallar (İngilizce, teknik).
- **`SECURITY.md`** — Güvenlik açığı bildirimi ve sır hijyeni kuralları.
- **`CONTRIBUTING.md`** — Katkı süreci ve lisans durumu.
- **`.env.example`** — Gerçek değerler İÇERMEYEN, sadece yer tutucu
  örnek ortam değişkenleri.
