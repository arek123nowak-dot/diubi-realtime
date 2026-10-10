# Mobile audio-capture feasibility POC

Pytanie, na które to odpowiada: czy DIUBI na telefonie może przechwycić
dźwięk odtwarzany przez INNĄ aplikację (Spotify, YouTube, Netflix), tak
jak dziś robi to na desktopie przez `chrome.tabCapture`/`getDisplayMedia`.

Status: kod źródłowy obu proof-of-concept gotowy, **nieprzetestowany w
tym środowisku** - sandbox, w którym pracuję, jest headless Linuxem bez
Xcode/macOS i bez podłączonego telefonu/emulatora z audio. Oba testy z
natury wymagają człowieka z fizycznym urządzeniem, bo kluczowym krokiem
jest system owy dialog zgody (ReplayKit broadcast picker / MediaProjection
consent), który nie da się zasymulować w CI czy sandboxie.

- `ios/` - Broadcast Upload Extension + host app z systemowym pickerem.
  Wymaga: Mac + Xcode + realny iPhone (nie symulator).
- `android/` - foreground service z `AudioPlaybackCaptureConfiguration`.
  Wymaga: Android Studio + realny telefon Android 10+ (emulator możliwy,
  ale zawodny dla tej konkretnej API).

Każdy folder ma własny `README.md` z krokami budowy i konkretnym
kryterium sukcesu (niezerowe RMS przechwyconego audio w trakcie
odtwarzania muzyki w innej appce + manualny odsłuch nagranego pliku).

## Co dalej po teście
Jeśli oba testy przejdą pozytywnie na realnym sprzęcie: mamy twarde
potwierdzenie, że ekran słuchania na mobile jest wykonalny, ale wymaga
kawałka natywnego kodu poza Bubble (patrz rozmowa o architekturze -
Bubble nie hostuje customowych native extension targetów typu Broadcast
Upload Extension czy foreground service z MediaProjection). Kolejny krok
to decyzja: hybrydowy moduł natywny (np. React Native/Expo plugin) wklejony
do appki Bubble, albo ejectowanie Bubble Mobile Starter do pełnego
natywnego projektu dla tego jednego ekranu.
