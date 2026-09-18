# DIUBI — prototyp tłumaczenia na żywo

Minimalny, działający szkielet real-time captioningu: przechwytuje dźwięk z
karty przeglądarki (np. otwarty w innej karcie odcinek Dreaming Spanish),
transkrybuje go na bieżąco (OpenAI Realtime API), tłumaczy każde ukończone
zdanie strumieniowo (Chat Completions) i pokazuje oba teksty na żywo.

To jest prototyp walidujący core value prop DIUBI ("understand the world" w
czasie rzeczywistym) — nie jest jeszcze podpięty pod Bubble/konto usera/bazę
słówek. Te elementy zostają w Bubble; ten serwis to osobny, lekki "silnik
real-time".

## Architektura

```
przeglądarka (tab z audio) --getDisplayMedia--> app.js
      --PCM16 16kHz przez WebSocket--> server.js
      --relay--> OpenAI Realtime API (transkrypcja, streaming)
                 |
                 +--> po każdym ukończonym zdaniu --> Chat Completions
                      (streaming tłumaczenie) --> z powrotem do przeglądarki
```

## Uruchomienie

1. `npm install` (już zrobione, jeśli klonujesz ten katalog od nowa — uruchom ponownie)
2. `cp .env.example .env` i uzupełnij `OPENAI_API_KEY` swoim kluczem OpenAI
   (potrzebny dostęp do Realtime API + Chat Completions)
3. `npm start`
4. Otwórz `http://localhost:3000`
5. W drugiej karcie przeglądarki odpal materiał audio/wideo do przetłumaczenia
   (np. Dreaming Spanish na YouTube)
6. Wróć do DIUBI, kliknij **Start**, w oknie wyboru źródła wybierz tę drugą
   kartę i **koniecznie zaznacz "Udostępnij dźwięk karty" / "Share tab audio"**
7. Napisy oryginalne i tłumaczenie powinny zacząć się pojawiać z opóźnieniem
   rzędu kilku sekund

## Znane ograniczenia prototypu (świadome uproszczenia, nie "bugi do zgłoszenia")

- Downsampling do 16kHz jest zrobiony metodą nearest-neighbor (najprostszą
  możliwą) — wystarcza do testów jakości ASR, ale docelowo warto zastąpić
  właściwym resamplerem (np. `AudioWorklet` + filtr dolnoprzepustowy).
- Brak retry/reconnect przy zerwaniu połączenia z OpenAI w trakcie sesji.
- Brak UI do wyboru mikrofonu / audio z całego systemu (tylko `tabCapture`
  przez `getDisplayMedia`) — rozszerzenie do przeglądarki (Manifest V3,
  `tabCapture` API) to naturalny kolejny krok, żeby ominąć konieczność
  ręcznego wyboru karty przy każdym starcie.
- Nazwy modeli/eventów Realtime API (`gpt-4o-transcribe`,
  `transcription_session.update`, `conversation.item.input_audio_transcription.*`)
  odzwierciedlają dokumentację OpenAI sprzed cutoffu wiedzy — jeśli po
  pierwszym teście dostaniesz błąd o nieznanym evencie/modelu, wklej mi
  dokładny komunikat z konsoli serwera, dostosuję kod do aktualnego API.
- Brak jakiejkolwiek autoryzacji/kontroli kosztów — każda sekunda audio to
  realne zużycie API OpenAI. Nie zostawiaj uruchomionego bez nadzoru.

## Następne kroki (do decyzji)

1. Test end-to-end z prawdziwym kluczem API i realnym materiałem — potwierdzić
   jakość transkrypcji hiszpańskiego i sensowność tłumaczenia przy typowym
   tempie mówienia.
2. Jeśli jakość/latencja OK: rozszerzenie do przeglądarki zamiast ręcznego
   wyboru karty (mniej tarcia, bliżej finalnego produktu).
3. Integracja z kontem Bubble (target_language usera, zapisywanie
   sesji/zdań do nauki jako `Segment`/`Token` do późniejszych powtórek).
4. Kliknięcie w słowo → istniejący mechanizm AI Context (do podłączenia).
