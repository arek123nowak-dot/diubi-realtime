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
- Dzienne limity nasłuchu (`MAX_USER_MINUTES_PER_DAY`, domyślnie 30 min na
  anonimowe urządzenie, i `MAX_GLOBAL_MINUTES_PER_DAY`, domyślnie 300 min
  łącznie) chronią przed przypadkowym przepaleniem budżetu, ale **nie są
  twardym zabezpieczeniem** — opierają się na tym samym anonimowym ID co
  pamiętnik, więc ktoś czyszczący dane przeglądarki resetuje sobie licznik.
  Wystarczające na testy ze znajomymi, nie na publiczny launch bez kontroli.

## Wdrożenie publiczne (Render)

Dziś backend działa tylko na `localhost` — poniższe kroki wystawiają go pod
publicznym adresem, żeby ktoś poza Tobą (np. nauczycielka testująca MVP)
mógł z niego skorzystać bez uruchamiania czegokolwiek na własnym komputerze.

1. Wypchnij repo na GitHub (już zrobione, jeśli czytasz to stąd).
2. Na [render.com](https://render.com): **New +** → **Web Service** → połącz
   repo `diubi-realtime`.
3. Ustawienia: Build Command `npm install`, Start Command `npm start`.
4. W zakładce **Environment** dodaj zmienne z `.env.example` (przede
   wszystkim `OPENAI_API_KEY`) — Render sam ustawia `PORT`, nie trzeba go
   podawać ręcznie.
5. Deploy. Render da publiczny adres `https://<nazwa>.onrender.com` —
   właśnie ten link (nie `localhost:3000`) wklejasz do `BACKEND_WS_URL` w
   `extension/background.js`, jeśli chcesz, żeby rozszerzenie też łączyło
   się z publicznym backendem zamiast lokalnego.

**Ważne zastrzeżenie:** `data/phrases.json` i `data/usage.json` to zwykłe
pliki na dysku kontenera. Na darmowym tierze Render dysk jest efemeryczny —
**każdy redeploy czyści pamiętnik i liczniki limitów**. Do krótkiego testu
ze znajomymi to akceptowalne ryzyko (i tak zaczynamy liczenie od zera), ale
nie nadaje się pod dłuższe użytkowanie — wtedy naturalny krok to migracja na
Postgres (Render ma go jako dodatkowy, płatny serwis), o czym niżej.

## Następne kroki (do decyzji)

1. Prawdziwe konto (magic link albo Google OAuth) w miejsce anonimowego ID —
   usuwa też furtkę resetowania limitu przez wyczyszczenie danych przeglądarki.
2. Migracja `store.js` i `usage.js` z plików JSON na Postgres — konieczne,
   jeśli wdrożenie ma przetrwać dłużej niż jeden test (patrz zastrzeżenie
   wyżej), nie tylko "ładniejsze".
3. Publikacja rozszerzenia w Chrome Web Store — dziś instaluje się tylko
   przez "Load unpacked" w trybie developerskim, co nie nadaje się do
   wysłania komuś jako link.
4. Prosty tryb powtórek na bazie zapisanych fraz w pamiętniku.
5. Aplikacja mobilna — docelowy kanał, ale przechwytywanie dźwięku z innej
   aplikacji jest na iOS/Androidzie dużo bardziej ograniczone niż
   `tabCapture` w Chrome; wymaga osobnej decyzji architektonicznej, nie
   rozszerzenia obecnego podejścia.
