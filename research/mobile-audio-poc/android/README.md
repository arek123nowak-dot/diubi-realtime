# Android audio-capture POC - setup & test

## Co to sprawdza
Czy nasza aplikacja może przechwycić dźwięk odtwarzany przez INNĄ aplikację
(Spotify, YouTube) na Androidzie, przez `AudioPlaybackCaptureConfiguration`
+ `MediaProjection`. Zero ASR/tłumaczenia tutaj - tylko potwierdzenie, że
bufor audio realnie do nas dociera i nie jest ciszą.

**Uwaga:** ten projekt nie był kompilowany w tym środowisku. Mam tu
Java/Gradle, ale nie Android SDK (`android.jar`, build-tools) i nie ma
podłączonego telefonu/emulatora z obsługą projekcji audio, więc nie mogłem
odpalić `gradle build` ani przetestować zgody systemowej (to z natury
wymaga człowieka z telefonem w ręku, klikającego systemowy dialog zgody).
Kod jest kompletny i gotowy do otwarcia w Android Studio.

## Wymagania
- Android Studio (najnowsza stabilna wersja)
- Telefon z Android 10+ (API 29+), realny sprzęt zalecany - emulatory mają
  różną, czasem słabą obsługę `AudioPlaybackCaptureConfiguration`
- USB debugging włączony na telefonie

## Kroki

1. Otwórz folder `android/` w Android Studio (File > Open). Android
   Studio sam dociągnie Gradle wrapper i zsynchronizuje projekt.
2. Podłącz telefon, uruchom (Run > Run 'app').
3. Przy pierwszym starcie zaakceptuj prompt o powiadomieniach (Android 13+).
4. Tapnij "Start Capture" - pojawi się systemowy dialog
   "Rozpocznij nagrywanie lub przesyłanie" (MediaProjection consent).
   Zatwierdź go.
5. Po zatwierdzeniu dialogu ekran w naszej appce pokazuje żywy odczyt:
   `Status`, `RMS`, licznik odebranych buforów. Zostań na tym ekranie.
6. Przełącz się na Spotify/YouTube (przez przycisk Home/gesty, appka
   nasza dalej działa w tle jako foreground service), odtwórz coś
   głośno, poczekaj 5-10 sekund, wróć do naszej appki.
7. Sprawdź ekran: `RMS` powinno być > 0.01 i widnieć "DZWIEK WYKRYTY",
   a licznik buforów powinien rosnąć. W ciszy RMS powinno wrócić blisko 0.
   To jest cały test - nie trzeba podłączać kabla USB do komputera ani
   używać adb/Logcat, chyba że coś nie działa (patrz sekcja niżej).
8. Opcjonalnie, dla pewności: ściągnij nagrany plik i odsłuchaj go wprost:
   ```
   adb pull /sdcard/Android/data/com.diubi.audiopoc/files/poc_capture.pcm
   ffmpeg -f s16le -ar 44100 -ac 1 -i poc_capture.pcm poc_capture.wav
   ```
   (plik jest surowym PCM mono 16-bit/44.1kHz, stąd konwersja przez ffmpeg)

## Czego szukamy / kryterium sukcesu
- Na ekranie: `RMS` > 0.01 podczas odtwarzania muzyki w Spotify/YouTube,
  bliskie 0 w ciszy, licznik buforów rośnie.
- Odsłuchany `poc_capture.wav` faktycznie zawiera to, co grało w drugiej
  appce - nie cisza, nie szum, nie dźwięk z mikrofonu telefonu.

## Jeśli coś nie działa
- Dialog zgody się nie pojawia / `createScreenCaptureIntent()` się wywala
  → sprawdź, że telefon ma API 29+.
- `rms` zawsze 0.0000 → dana aplikacja źródłowa może mieć ustawione
  `allowAudioPlaybackCapture="false"` w swoim manifeście (rzadkie u
  konsumenckich appek, ale sprawdź na kilku: Spotify, YouTube, przeglądarka
  z odtwarzanym wideo).
- `SecurityException` przy starcie `AudioRecord` → serwis musi być
  uruchomiony jako foreground service PRZED wywołaniem `startRecording()`
  (już tak jest w kodzie - `startAsForeground()` leci jako pierwsze w
  `onStartCommand`), i musi iść ten sam `MediaProjection` token, który
  dostaliśmy z Activity.
