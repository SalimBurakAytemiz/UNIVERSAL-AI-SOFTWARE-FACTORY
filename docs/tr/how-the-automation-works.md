# Otomasyon Nasıl Çalışır?

İlk günden itibaren:

1. Supervisor GitHub ile güvenli senkronizasyon yapar.
2. Claude mevcut milestone'u yapar ve local commit oluşturur.
3. Supervisor test/lint/typecheck/build çalıştırır.
4. Commit GitHub'a otomatik push edilir.
5. Remote SHA ile local HEAD birebir doğrulanır.
6. Codex sabit commit'i bağımsız review eder.
7. Blocker varsa bulgular otomatik Claude'a gider.
8. Claude fix + yeni commit yapar.
9. Yeni commit tekrar GitHub'a push edilir.
10. Codex yeni commit'i review eder.
11. CLEAN gelirse sonraki milestone'a geçilir.

Force push, hard reset ve otomatik rebase yasaktır.
Git geçmişi ayrışırsa sistem durur ve Founder'a haber verir.
