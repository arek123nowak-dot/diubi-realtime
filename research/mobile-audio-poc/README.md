# Mobile audio-capture feasibility POC

Pytanie, na które to odpowiada: czy DIUBI na telefonie może przechwycić
dźwięk odtwarzany przez INNĄ aplikację (Spotify, YouTube, Netflix), tak
jak dziś robi to na desktopie przez `chrome.tabCapture`/`getDisplayMedia`.

Status:

- **Android: POTWIERDZONE na realnym sprzęcie (2026-10-15).** Przetestowane
  na Realme 11 Pro+ 5G (Android 15, ColorOS), fizyczne urządzenie przez
  USB, nie emulator. Wynik: `AudioPlaybackCaptureConfiguration` +
  `MediaProjection` realnie przechwytuje dźwięk z innej aplikacji w PEŁNYM
  tle (appka źródłowa całkowicie poza ekranem, nasza appka na pierwszym
  planie) - dokładnie scenariusz docelowy dla DIUBI. Potwierdzone krok po
  kroku: lokalnie nagrany plik audio odtwarzany przez appkę Dyktafon w
  tle → RMS > 0 w naszej appce. Po drodze odkryte i wyjaśnione:
  - **Spotify celowo blokuje przechwytywanie** (ustawia
    `setAllowedCapturePolicy(ALLOW_CAPTURE_BY_NONE)` dla ochrony
    licencjonowanej muzyki) - to oczekiwane zachowanie Spotify, nie błąd
    w naszym kodzie ani ograniczenie Androida. Dowolna appka może się tak
    zabezpieczyć; nie da się tego obejść.
  - Test z YouTube w trybie "pojedyncza aplikacja" dawał RMS=0, ale
    okazało się, że YouTube samo pauzowało odtwarzanie przy utracie
    widoczności (appka nie wspiera odtwarzania w tle bez YouTube
    Premium) - to nie był problem przechwytywania, tylko factyczny brak
    dźwięku do złapania.
  - Wniosek: mechanizm działa poprawnie i responsywnie (cisza = RMS≈0,
    dźwięk = RMS>0) dla źródeł, które faktycznie grają w tle. Jedyne
    realne ograniczenie to świadome blokady po stronie konkretnych appek
    (DRM/licencje), nie technologia przechwytywania sama w sobie.
- **iOS: nieprzetestowane.** Kod gotowy, ale wymaga Maca z Xcode i
  realnego iPhone'a, których nie mieliśmy jeszcze pod ręką w tej rundzie
  testów.

- `ios/` - Broadcast Upload Extension + host app z systemowym pickerem.
  Wymaga: Mac + Xcode + realny iPhone (nie symulator).
- `android/` - foreground service z `AudioPlaybackCaptureConfiguration`.
  Wymaga: Android Studio + realny telefon Android 10+ (emulator możliwy,
  ale zawodny dla tej konkretnej API).

Każdy folder ma własny `README.md` z krokami budowy i konkretnym
kryterium sukcesu (niezerowe RMS przechwyconego audio w trakcie
odtwarzania muzyki w innej appce + manualny odsłuch nagranego pliku).

## Co dalej
Android strona pytania o wykonalność jest zamknięta z pozytywnym wynikiem
na realnym telefonie. Zostaje:
1. Ten sam test na iOS, gdy będzie dostępny Mac + iPhone.
2. Decyzja architektoniczna (patrz rozmowa o Bubble): skoro mechanizm
   wymaga natywnego kodu (Broadcast Upload Extension na iOS, foreground
   service z MediaProjection na Android), Bubble nie może tego hostować
   samodzielnie - potrzebny hybrydowy moduł natywny (np. React
   Native/Expo plugin) wklejony do appki Bubble, albo ejectowanie Bubble
   Mobile Starter do pełnego natywnego projektu dla tego jednego ekranu.
