# kriptohud

Tek dosya sürümü: [`index.js`](index.js) — konsola veya snippet olarak yapıştırılabilir.

## Chrome / Edge uzantısı (MV3)

Profesyonel paket: [`extension/`](../extension/) klasörü.

1. Chrome’da `chrome://extensions` → **Geliştirici modu** → **Paketlenmemiş öğe yükle** → `extension` klasörünü seçin.
2. Hedef borsa / panel sitesinde bir sekme açık tutun (DOM okuma için gerekli).
3. Uzantı ikonuna tıklayarak **side panel**i açın veya sitedeki **Side paneli aç** düğmesini kullanın.
4. `extension/manifest.json` içindeki `content_scripts[0].matches` ve `host_permissions` değerlerini yalnızca güvendiğiniz alan adlarıyla daraltmanız önerilir (şu an `https://*/*` geniştir).
