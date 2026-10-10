# iOS audio-capture POC - setup & test

## Co to sprawdza
Czy nasza aplikacja może przechwycić dźwięk odtwarzany przez INNĄ aplikację
(Spotify, YouTube, Netflix) na iPhonie, przez ReplayKit Broadcast Upload
Extension. Zero ASR/tłumaczenia tutaj - tylko potwierdzenie, że bufor audio
realnie do nas dociera i nie jest ciszą.

**Uwaga:** ten kod nie był kompilowany ani testowany w tym środowisku -
sandbox, w którym pracuję, jest Linuxem bez Xcode/macOS, a ReplayKit
wymaga realnego iPhone'a (symulator nie przechwytuje dźwięku innych
aplikacji). Poniżej dokładne kroki, żeby ktoś z Makiem i iPhone'em mógł
to złożyć i przetestować w ~20-30 minut.

## Wymagania
- Mac z Xcode 15+
- iPhone z iOS 16+ podłączony kablem (nie symulator)
- Konto Apple Developer (darmowe wystarczy do testu na własnym urządzeniu;
  App Groups działają też z darmowym kontem, o ile signing jest poprawny)

## Kroki

1. **Nowy projekt w Xcode**: File > New > Project > iOS > App.
   - Product Name: `DiubiAudioPOC`
   - Interface: SwiftUI
   - Bundle ID: `com.diubi.audiopoc` (ważne - musi się zgadzać z plikami tutaj)

2. **Dodaj target rozszerzenia**: File > New > Target > Broadcast Upload
   Extension.
   - Product Name: `BroadcastExtension`
   - Finalny bundle ID targetu: `com.diubi.audiopoc.BroadcastExtension`
   - Xcode wygeneruje własny `SampleHandler.swift` - **zastąp go** plikiem
     z `BroadcastExtension/SampleHandler.swift` z tego folderu.
   - Zastąp wygenerowany `Info.plist` tym z `BroadcastExtension/Info.plist`
     (albo tylko dopisz brakujące klucze `NSExtension`).

3. **App Groups (kluczowy krok)**: w Xcode, dla OBU targetów
   (`DiubiAudioPOC` i `BroadcastExtension`):
   - Signing & Capabilities > + Capability > App Groups
   - Dodaj identyczny identyfikator: `group.com.diubi.audiopoc`
   - Podłącz pliki `.entitlements` z tego folderu (albo po prostu
     odznacz/zaznacz grupę w UI Xcode - sam dogeneruje entitlements).

4. **Host app UI**: zastąp wygenerowany `ContentView.swift` plikiem z
   `HostApp/ContentView.swift`.

5. **Build & Run** na podłączonym iPhonie (nie symulator). Zaakceptuj
   prompt o zaufaniu deweloperowi w Ustawieniach, jeśli się pojawi.

6. **Test**:
   - W naszej appce tapnij okrągły przycisk pickera (RPSystemBroadcastPickerView).
   - Wybierz "BroadcastExtension" z listy.
   - Tapnij "Start Broadcast" (system pokaże czerwony pasek "nagrywanie ekranu").
   - Przełącz się do Spotify/YouTube i odtwórz coś głośno.
   - Wróć do naszej appki - linie poniżej pickera powinny aktualizować się
     co sekundę i pokazywać `rms=0.0XXX` (wartość > 0 = realny dźwięk,
     nie cisza).
   - Zatrzymaj broadcast (czerwony pasek > Stop).

## Czego szukamy / kryterium sukcesu
- `audioApp` buffery pojawiają się (nie tylko `audioMic`) - to potwierdza,
  że ReplayKit faktycznie oddaje nam dźwięk INNEJ aplikacji, a nie tylko
  mikrofon.
- `rms` > 0 w trakcie odtwarzania muzyki/wideo w innej appce, ≈0 w ciszy -
  potwierdza, że to prawdziwy sygnał, a nie zaślepiony/zerowy bufor (to
  był realny problem zgłaszany na forum Apple przez innych developerów).

## Jeśli coś nie działa
- Brak linii w logu / "App Group container not found" → App Groups nie są
  identyczne na obu targetach, sprawdź dokładnie string.
- `rms` zawsze 0.0000 nawet przy głośnej muzyce → możliwe, że to ten
  sam problem zgłaszany na forum Apple (zerowe buffery z niektórych
  źródeł) - w takim razie podłącz iPhone kablem i obserwuj dodatkowo
  przez Console.app na Macu, filtrując po `com.diubi.audiopoc`, żeby
  zobaczyć pełny `os_log`.
- Picker nie pokazuje naszego rozszerzenia → `preferredExtension` w
  `ContentView.swift` musi być DOKŁADNIE bundle ID targetu rozszerzenia.
