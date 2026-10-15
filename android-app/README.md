# DIUBI Android - natywny host

Cienka natywna appka: pełnoekranowy `WebView` wyświetlający istniejącą
appkę webową DIUBI (zero zmian w UI/backendzie) + natywny moduł audio
(`MediaProjection` + `AudioPlaybackCaptureConfiguration`, dokładnie ten
sam mechanizm przetestowany i potwierdzony w
`research/mobile-audio-poc/android/`), który podaje przechwycony dźwięk
do strony przez most JS zamiast przeglądarkowego `getDisplayMedia()`.

Backend (`server.js`) nie wie i nie musi wiedzieć, skąd przyszło audio -
`public/app.js` wysyła dokładnie ten sam komunikat
`{type:"audio_chunk", audio: "<base64 PCM16 24kHz mono>"}` niezależnie od
tego, czy źródłem jest karta przeglądarki na komputerze, czy telefon.

## Jak to działa (most JS)

1. `MainActivity` ładuje adres serwera w `WebView` i wstrzykuje obiekt
   `DiubiNative` (przez `addJavascriptInterface`).
2. `public/app.js` w `start()` sprawdza, czy `window.DiubiNative` istnieje
   - jeśli tak, zamiast `getDisplayMedia()` wywołuje
   `DiubiNative.requestAudioCapture()` i czeka.
3. Natywny kod pokazuje systemowy dialog zgody `MediaProjection`, po
   zatwierdzeniu startuje `CaptureService` (foreground service) i woła z
   powrotem `diubiCaptureStarted()` w stronie - to dopiero otwiera
   WebSocket (`openSocket()`), tak jak przy normalnym Starcie w
   przeglądarce.
4. `CaptureService` czyta audio z `AudioRecord` (44100Hz), przepróbkowuje
   do 24000Hz (ten sam prosty nearest-neighbor downsampling co w
   `app.js`, żeby zachować spójność), koduje do base64 i dla każdej
   paczki wywołuje `webView.evaluateJavascript("diubiFeedAudioChunk('...')")`.
5. `diubiFeedAudioChunk(base64)` w stronie robi dokładnie to, co dotąd
   robił `processorNode.onaudioprocess` w przeglądarce: wysyła
   `{type:"audio_chunk", audio: base64}` po tym samym `ws`.
6. Stop analogicznie: `stop()` w stronie dodatkowo woła
   `DiubiNative.stopAudioCapture()`, który zatrzymuje `CaptureService`.

Efekt: Pamiętnik, Powtórka, Moja nauka, ostrzeżenia o niskiej pewności
transkrypcji - wszystko działa na telefonie bez dotykania tych funkcji,
bo z punktu widzenia serwera i reszty strony nic się nie zmieniło poza
źródłem audio.

## Status

**Przepływ end-to-end POTWIERDZONY na realnym telefonie (2026-10-15)** -
Realme 11 Pro+ 5G (Android 15). Start → systemowy dialog MediaProjection
→ `CaptureService` → most JS → WebSocket → serwer → transkrypcja na żywo
widoczna w appce. Dokładnie ten scenariusz, o który chodziło: appka na
pierwszym planie, źródło audio w pełni w tle.

Po drodze znaleziony i naprawiony jeden realny bug (nie w moście audio -
tam wszystko zadziałało za pierwszym razem): `crypto.randomUUID()` w
`getUserId()` rzucał wyjątkiem, bo jest dostępne tylko w "bezpiecznym
kontekście" (`https://` albo `localhost`), a WebView ładuje appkę przez
zwykłe `http://<lan-ip>` podczas lokalnych testów. Naprawione fallbackiem
w `public/app.js` (`generateUuid()`).

Jeszcze nieprzetestowane w tej rundzie: tłumaczenie, zapis frazy do
Pamiętnika, odtworzenie klipu w Powtórce, przycisk Stop, zachowanie przy
zgaszonym ekranie.

## Uruchomienie

1. Upewnij się, że `server.js` działa i jest dostępny w sieci lokalnej
   (nie tylko `localhost`) - sprawdź adres IP komputera w tej samej sieci
   Wi-Fi co telefon:
   ```
   ipconfig
   ```
   (Windows) - szukaj "Adres IPv4" przy aktywnej karcie Wi-Fi, np.
   `192.168.1.23`. Serwer musi być uruchomiony (`npm start` w głównym
   folderze projektu) i nasłuchiwać na porcie z `.env` (domyślnie 3000).
2. Jeśli Windows Firewall pyta o zgodę dla Node.js przy pierwszym
   uruchomieniu serwera - zezwól (analogicznie jak wcześniej przy `adb`),
   inaczej telefon nie połączy się przez sieć.
3. Otwórz folder `android-app/` w Android Studio (File > Open), poczekaj
   na Gradle sync.
4. Podłącz telefon przez USB (Debugowanie USB już włączone z poprzedniego
   testu), wybierz go z listy urządzeń, Run ▶.
5. Przy pierwszym uruchomieniu appka zapyta o adres serwera - wpisz
   `http://<IP-komputera>:3000` (albo `https://...` jeśli już wdrożone na
   Render).
6. Appka załaduje normalny interfejs DIUBI. Kliknij "Start" tak jak w
   przeglądarce - pojawi się systemowy dialog `MediaProjection` zamiast
   okna wyboru karty.
7. Przetestuj cały przepływ: transkrypcja na żywo, tłumaczenie, zapisanie
   frazy do Pamiętnika, odtworzenie klipu w Powtórce.

Żeby zmienić zapisany adres serwera później: Ustawienia systemowe >
Aplikacje > DIUBI > Pamięć > Wyczyść dane, potem uruchom appkę ponownie.

## Czego to NIE rozwiązuje jeszcze

- Appka nie ma ikony/onboardingu/postaci Diubi - to czysty, funkcjonalny
  szkielet do testu przepływu end-to-end, nie gotowy produkt.
- Zachowanie przy zgaszonym ekranie/długim tle telefonu nieprzetestowane.
- iOS - osobne zadanie, patrz `research/mobile-audio-poc/ios/`.
