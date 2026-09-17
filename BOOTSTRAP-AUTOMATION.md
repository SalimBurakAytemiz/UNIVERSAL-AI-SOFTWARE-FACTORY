# Day-Zero Full Automation

Bu supervisor yalnız yerel Factory geliştirmesi içindir. Canonical architecture,
roadmap, phase/milestone ve Founder yetkisi değişmez. Phase 6/10 governance veya
evidence runtime'ının tamamlandığı iddia edilmez.

## Başlatma

Repo klasöründe tek giriş noktası:

```powershell
.\scripts\start-full-auto.ps1
```

Aynı giriş noktasının yardımcı modları:

```powershell
.\scripts\start-full-auto.ps1 -ValidateOnly
.\scripts\start-full-auto.ps1 -Check
.\scripts\start-full-auto.ps1 -Status
```

`-ValidateOnly` deterministik testleri çalıştırır; model/GitHub çağırmaz.
`-Check` küçük, araçsız inference istekleriyle erişimi sınar; kod üretmez veya push yapmaz.
Varsayılan çalıştırma gerçek milestone uygulaması, commit ve push yapar. Node.js 24+,
Git ve npm gerekir. Native CLI oturumlarının önceden açılmış olması gerekir.
CLI yoksa uygun fallback denenir; bir CLI veya gelecekteki credential eksikliği
diğer çalışan kaynakları engellemez. Mevcut Git değişiklikleri varsa otomatik silinmez.
Aktif promptlar `prompts/AUTO-BUILDER.md`, `AUTO-REVIEW.md` ve `AUTO-NEXT.md` dosyalarıdır;
önceki Claude/OpenCode promptları geçmiş referans olarak korunur, yeni supervisor bunları çağırmaz.

## Akış ve sınırlar

Claude primary builder → OpenCode CLI Free → OmniRoute'ta credential-ready free modeller.
Codex primary reviewer → builder katkı listesinde olmayan aileden ücretsiz reviewer.
Başarılı bağımsız review sonrası checkpoint planlayıcısı aynı builder havuzunu kullanır;
Claude kotası planlayıcıyı tek başına durdurmaz.

Modeller araç çalıştırmak yerine hash ve commit bağlı JSON dosya önerileri üretir.
Eksik bağlam için dosya isteyebilirler; bağlam/çıktı/round limitleri aşılırsa kapanır.
Supervisor yol, içerik, dosya hash'i, korunan dosya ve risk kontrollerini yapar,
öneriyi uygular, commit oluşturur, deterministik doğrular, push eder ve remote SHA'yı
eşleştirir. Review öncesi ve sonrası HEAD/working-tree/remote hedefi sabittir.
Her bulgu yeni commit ile giderilir. Aynı commit yeniden review edilmez.

En fazla 3 review ve 3 toplam remediation batch'i vardır. Üçüncü BLOCKED review'dan
sonra dördüncü review/düzeltme başlatılmaz. Varsayılan run sınırı 10 milestone'dur.
Doğrulama başarısızlığı builder'a taşınır; bilinmeyen/hatalı çıktı CLEAN sayılmaz.
Repository package toolchain'i varsa lint/typecheck/test/build scriptleri zorunludur.
Bootstrap testlerinin geçmesi Phase 0'ın tamamlandığı anlamına gelmez.

Force push, hard reset, rebase, branch history rewrite yoktur. Local/remote divergence,
beklenmedik HEAD değişimi ve yarım kalmış dosya transaction'ı Founder dikkatine durur.

Risk-5, production, irreversible migration, ödeme, korunan policy/supervisor değişimi
bu bootstrap'ın izin verdiği eylemler değildir. Böyle bir iş veya
`FOUNDER_APPROVAL_REQUIRED` otomatik olarak başka modele devredilmez. JSON'daki bir
approval alanı Founder yetkisi oluşturmaz; bu supervisor kritik eylemler için approval
verme veya bunları yürütme API'si içermez. Yerel test scriptleri kullanıcı makinesinin
izinleriyle çalışır; bu dar bootstrap OS düzeyinde genel bir sandbox değildir.

## Kayıtlı provider/model havuzu

| Kaynak | Durum / politika |
| --- | --- |
| Claude Code CLI | Mevcut abonelik oturumu, primary builder/planner; otomatik yeni API harcaması yok |
| OpenCode Union Alpha Free | Founder tarafından doğrulanmış builder/planner; reviewer olarak kapalı |
| OpenCode MiMo V2.5 Free | Health-check sonrası builder/planner veya bağımsız reviewer adayı |
| OpenCode Nemotron 3 Ultra Free | Health-check sonrası builder/planner veya bağımsız reviewer adayı |
| NVIDIA NIM / DeepSeek | REGISTERED; credential yokken INACTIVE / NO_CREDENTIAL |
| OpenRouter / Nemotron 3 Ultra :free | REGISTERED; credential yokken INACTIVE / NO_CREDENTIAL; canlı fiyat kataloğu sıfır olmalı |
| Kiro | REGISTERED / INACTIVE; native-interface şartı nedeniyle OmniRoute otomatik havuzunda kapalı |
| Pollinations | REGISTERED / INACTIVE; güvenilir, kesin sıfır maliyetli coding rotası doğrulanmadı |

Bağımsızlık tüm milestone katkılarına göre belirlenir; yalnız son builder'a bakılmaz.
Nemotron'un OpenCode ve OpenRouter rotaları aynı aile sayılır. Union Alpha'nın
altta yatan üreticisi açıklanmamıştır: `union-alpha` yayımlanmış model kimliği üzerinden
takip edilir, farklı bir temel aileye ait olduğu iddia edilmez ve reviewer yapılmaz.
Kullanıcının doğruladığı Union Alpha builder erişimi korunmuştur. Kapalı modelin
gizli mimarisine ilişkin kriptografik bağımsızlık kanıtı bu bootstrap'ın kapsamı dışıdır.

Model kimlikleri sabittir; otomatik router/combo/paid model seçimi yoktur.
OpenCode primary/helper model aynı free kimliğe sabitlenir. OmniRoute direct model ve
tek provider bağlantısına sabitlenir; alias/aynı isimli combo/özel endpoint varsa durur.
OpenRouter için `:free`, sıfır fiyat ve `allow_fallbacks:false` zorunludur.
Sağlayıcıdan farklı model kimliği dönerse yanıt reddedilir. Ücretli havuz bulunmaz.
Mevcut Claude/ChatGPT abonelik hakları ücretsiz üçüncü-party kredisi olarak tanımlanmaz.

## Sonradan credential ekleme

Gateway: `http://127.0.0.1:20128`. Buradaki Zen API bağlantısı, yalnız OpenCode CLI
içinden erişilebilen free modeller için alternatif rota olarak kullanılmaz.

1. NIM veya OpenRouter hesabını OmniRoute panelinde resmi API key yöntemiyle ekleyin.
   İlgili provider için tek aktif bağlantı kullanın. Ücretli fallback/combo tanımlamayın.
2. Factory için yalnız izin verilen ücretsiz modelleri kapsayan OmniRoute API key üretin.
3. Key'i `FACTORY_OMNIROUTE_API_KEY` ortam değişkenine verip giriş noktasını yeniden açın;
   veya `.ai/automation/credentials.json` içine `omnirouteApiKey` alanıyla yerel olarak koyun.
   Bu dosya Git dışında kalır ve her health-check'te tekrar okunur; gerçek key'i chat'e yazmayın.
4. NVIDIA için yalnız ücretsiz developer/trial erişimini kullandığınızı doğruladıktan sonra
   `FACTORY_NIM_FREE_TIER=1` veya yerel credentials dosyasında `nimFreeTier:true` kullanın.
   Bu alan ücretli harcamaya izin vermez. Kota bitince durur/fallback yapar.
5. `-Check` çalıştırın. Erişim, model ve ücretsiz fiyat kontrolleri geçerse aday otomatik
   HEALTHY olur; registry'yi elle ACTIVE yapmanız gerekmez. Credential eksikliği kurulum
   hatası değildir. Kiro/Pollinations için yalnız key eklemek uygunluk engelini kaldırmaz.

Key'ler raporlara/state'e yazılmaz. CLI araç yolu gerekiyorsa
`FACTORY_CLAUDE_COMMAND`, `FACTORY_OPENCODE_COMMAND`, `FACTORY_CODEX_COMMAND` kullanılabilir.
Giriş scripti mevcut yerel CLI klasörlerini ve kurulu Codex standalone binary'sini bulur.

## State, quarantine ve recovery

Canonical `.ai/MASTER_STATE.json` başlangıç aşamasında değiştirilmez.
Eski `.ai/AUTOMATION_STATE.json` ilk açılışta seed olarak korunur.
Çalışma state'i `.ai/automation/state.json` içindedir: provider availability,
quota, retryAt, failure reason, task/model attempts, builder contributors, reviewed SHA,
cycle sayısı, bekleyen adım ve remote-SHA kayıtları tutulur.
Review çıktıları `.ai/automation/reviews/` altındadır ve digest ile bağlanır.
Bu yerel kayıtlar Phase 6'nın güvenilir attestation sistemi yerine geçmez.

Quota/rate-limit/auth/network/timeout hataları quarantine üretir. Retry-After ve
artan cooldown uygulanır. Aynı model/görev için en fazla iki inference denemesi;
ikinci deneme öncesinde yeni başarılı health-check gerekir. Bozuk sonuç aynı task/commit
için tekrar denenmez. Tüm uygun kaynaklar geçici kapalıysa 30 saniyeyi aşmayan beklemelerle
recovery yapılır; toplam varsayılan bekleme üst sınırı bir saattir. Ctrl+C ile durdurulabilir.
Yeni çalıştırma kayıtlı adımdan devam eder; canonical milestone sessizce atlanmaz.

Tek supervisor kilidi vardır. Zorla kapatma sonrası kilit kalırsa önce kayıtlı PID'nin
çalışmadığını doğrulayın; yalnız sonra `.ai/automation/supervisor.lock` dosyasını kaldırın.
`pendingApply` varsa dosyaları/commit'i incelemeden state'i temizlemeyin; otomatik reset yoktur.

## Değerlendirme kaynakları — 2026-09-17

- [OpenCode Zen model ve free fiyat tablosu](https://opencode.ai/docs/zen/)
- [OpenRouter model/fiyat kataloğu](https://openrouter.ai/api/v1/models) ve [free varyant](https://openrouter.ai/docs/guides/routing/model-variants/free)
- [NVIDIA resmi API Catalog başlangıcı](https://docs.api.nvidia.com/nim/docs/api-quickstart)
- [Kiro ücretsiz planı ve native interface koşulları](https://kiro.dev/pricing/)
- [Pollinations resmi API ve Pollen maliyet alanları](https://github.com/pollinations/pollinations/blob/main/APIDOCS.md)
- [Codex non-interactive kullanım](https://developers.openai.com/codex/noninteractive/)

## Checkpoint hata ayrımı
Eksik/geçersiz risk metadatası INVALID_RESPONSE olarak reddedilir; açık onay talebi veya Risk-5 güvenli biçimde durur. Son önerinin model, görev, risk ve dosya yolları runtime state içindeki lastProposal alanında tutulur. Güvenlik duruşları yeniden başlatmayla aşılmaz. Terminal aktif adımı ve review sayısını gösterir.
