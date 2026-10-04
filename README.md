# DIUBI — prototyp tłumaczenia na żywo

Silnik real-time: przechwytuje dźwięk z karty przeglądarki (strona webowa) albo
z aktywnej karty bezpośrednio (rozszerzenie Chrome, `extension/`), transkrybuje
go na bieżąco (OpenAI Realtime API), tłumaczy każde ukończone zdanie
strumieniowo (Chat Completions) i pokazuje oba teksty na żywo, obok siebie.

Druga warstwa, ponad samym tłumaczeniem: zaznaczenie słowa/frazy w oryginale
pokazuje jej wyjaśnienie w tym konkretnym kontekście (nie ogólną definicję
słownikową) + przykład + wymowę, z przyciskiem **⭐ Zapamiętaj** zapisującym
frazę razem z kontekstowym zdaniem, źródłem i datą do **Mój pamiętnik** —
to jest pierwszy pełny cykl produktu (słuchasz → nie rozumiesz → klikasz →
rozumiesz → zapisujesz → wracasz później), nie tylko translator.

## Architektura

```
przeglądarka (tab z audio) --getDisplayMedia / tabCapture--> app.js / extension
      --PCM16 24kHz przez WebSocket--> server.js
      --relay--> OpenAI Realtime API (transkrypcja, streaming)
                 |
                 +--> po każdym ukończonym zdaniu --> Chat Completions
                      (streaming tłumaczenie) --> z powrotem do klienta

      zaznaczenie frazy --> POST /api/explain --> Chat Completions (JSON mode)
      "Zapamietaj"      --> POST /api/phrases --> data/phrases.json
      "Moj pamietnik"   --> GET  /api/phrases --> data/phrases.json
```

Tożsamość użytkownika na tym etapie to trwałe anonimowe ID generowane w
przeglądarce (localStorage w wersji web, `chrome.storage.local` w
rozszerzeniu) — żadnego logowania jeszcze nie ma. To celowe uproszczenie na
czas pierwszych testów; prawdziwe konto (magic link / Google) ma sens dopiero
przy publicznym wdrożeniu backendu, razem z przejściem z pliku JSON na
Postgres (patrz `store.js` — jedna tabela, migracja 1:1).

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

1. Publiczne wdrożenie backendu (Render/Railway) — dziś działa tylko lokalnie
   (`localhost:3000`), więc tylko Ty możesz go używać.
2. Prawdziwe konto (magic link albo Google OAuth) w miejsce anonimowego ID.
3. Migracja `store.js` z pliku JSON na Postgres (naturalny moment: razem z
   publicznym wdrożeniem).
4. Prosty tryb powtórek na bazie zapisanych fraz w pamiętniku.
