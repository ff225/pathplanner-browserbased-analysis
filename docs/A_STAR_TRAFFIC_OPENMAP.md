# A*: traffico real-time e uso di OpenStreetMap

> Risposta alle domande poste durante la revisione GUI. **Nessuna modifica al codice A* in questo documento.**

## 1. Possiamo ottenere dati sul traffico gratuitamente?

**Breve: sì, ma con limiti importanti.**

### Fonti veramente libere

- **OpenStreetMap (OSM) di per sé non include traffico real-time.**
  - OSM ha la rete stradale, i limiti di velocità, i sensi unici, le restrizioni di svolta, ecc.
  - Non fornisce velocità istantanee o congestione.
- **OpenTraffic / Mapzen / simili**
  - Progetti passati o non più operativi a livello di API pubblica stabile.
  - Non esiste attualmente un equivalente "Wikipedia del traffico" affidabile per produzione.

### Free tier commerciali (uso limitato, ma utile per prototipo)

| Provider | Cosa offre | Free tier tipico | Vincoli |
|---|---|---|---|
| **TomTom** | Traffic Flow + Incidents + Routing con traffico | ~2.500 transazioni/giorno | Richiede carta di credito per superare il free tier; pricing in evoluzione (luglio 2026) |
| **HERE** | Real-Time Traffic API, flow/incidents | Piano evaluation + partner tier | Crediti limitati; copertura globale molto buona |
| **Mapbox Directions** | Routing con annotazioni traffico (`annotations=duration,speed,congestion`) | 100.000 tile-free requests/mese poi pay-as-you-go | Il traffico real-time è a pagamento, non nel free tier |
| **Google Maps** | Directions con traffico | Niente tier gratuito significativo per API server-side | Costoso, sconsigliato per un progetto accademico |

### Cosa si può fare gratis *oggi* senza contratti

1. **OSRM/Valhalla su grafo OSM**: routing reale, veloce, senza traffico.
2. **Mapbox Directions base**: percorso su strada reale, ma senza traffic-aware.
3. **TomTom/HERE evaluation**: testare il traffico in aree limitate.
4. **Crowdsourcing interno**: se si dispone di una flotta di dispositivi/probes, si possono calcolare speed medie per segmento e alimentare OSRM con profili di velocità custom.

### Conclusione sulla domanda traffico

- Per un **demo/prototipo** si può ottenere traffico gratis tramite i free tier TomTom/HERE.
- Per un **sistema scalabile e persistente** il traffico real-time diventa a pagamento.
- Non esiste una fonte open-source globale, stabile e gratuita di traffico real-time paragonabile ai provider commerciali.

---

## 2. Possiamo migliorare l’algoritmo A* usando OpenStreetMap?

**Sì, in due modi distinti.**

### Opzione A: delegare il routing a un motore OSM (consigliata)

Invece di implementare A* a mano su una griglia, si usa un motore di routing che lavora sul **grafo stradale reale** di OSM.

| Motore | Algoritmo | Pro | Contro |
|---|---|---|---|
| **OSRM** | Contraction Hierarchies / MLD | Estremamente veloce, HTTP REST, profili Lua personalizzabili | Non supporta nativamente traffico real-time; richiede preprocessing del PBF |
| **Valhalla** | A* con landmarks / altri | Più flessibile per costi multipli, svolte, evitamenti | Più lento di OSRM, setup più complesso |
| **OpenRouteService (ORS)** | Variazione Dijkstra/A* | API online/hosting, buona documentazione | Meno personalizzabile in locale |

**Come integrarlo con i pesi ambientali:**

1. OSRM/Valhalla restituisce una o più geometrie candidate (route).
2. Il backend campiona i punti lungo la geometria.
3. Per ogni punto recupera i dati ambientali (qualità dell’aria, temperatura, rumore, pendenza).
4. Calcola un **costo combinato**:
   ```
   costo_totale = durata_base_OSRM
                  + α · penalità_qualità_aria
                  + β · penalità_temperatura
                  + γ · penalità_rumore
                  + δ · penalità_pendenza
   ```
5. Sceglie la geometria con costo minore o restituisce entrambe (diretta vs ottimizzata).

Questo approccio è molto più veloce e realistico di una griglia A* custom, perché il grafo stradale garantisce che il percorso sia percorribile.

### Opzione B: A* custom su grafo OSM

Se si vuole mantenere il controllo totale dell’algoritmo:

1. **osmnx** (Python) scarica il grafo stradale OSM per un’area.
2. Si assegnano pesi agli archi:
   - lunghezza / velocità massima (tempo base)
   - fattore ambientale calcolato dal punto medio dell’arco
   - (opzionale) fattore traffico se disponibile
3. Si esegue **A* con euristica haversine** tramite `networkx` o implementazione custom.

**Vantaggio:** massima flessibilità sui pesi.
**Svantaggio:** su aree grandi è più lento di OSRM/Valhalla e richiede caching del grafo.

### Perché la griglia A* attuale è limitata

- L’A* su griglia può generare percorsi che attraversano edifici, parchi privati, sensi unici, ecc.
- I costi ambientali sono interpolati sulla griglia, non sulla rete stradale.
- Passare a OSRM/Valhalla risolve il problema di **percorribilità** e permette di concentrarsi solo sulla funzione di costo ambientale.

---

## 3. Come integrare il traffico (se si decide di farlo)

### Con OSRM

OSRM accetta **speed profiles** in fase di preprocessing o aggiornamenti runtime (a seconda della versione e del flusso):

- Si ottiene una velocità media per segmento stradale da TomTom/HERE/propri probes.
- Si costruisce un CSV/OSM-tag con `maxspeed` o si usa l’API traffic di OSRM.
- Si rigenera il grafo (costoso) o si applica un moltiplicatore runtime (limitato).

**Problema:** il traffico real-time richiede aggiornamenti frequenti del grafo, che non è banale.

### Con algoritmo A* custom

- Si scarica il grafo OSM.
- Si mappano i segmenti OSM sui dati traffic di TomTom/HERE.
- Si aggiornano i pesi degli archi in tempo reale (in memoria) prima di ogni query.
- Si esegue A*.

**Problema:** mapping tra segmenti commerciali e OSM richiede tool come `HERE Map Matching` o `TomTom Map Matching`, spesso a pagamento.

---

## 4. Raccomandazione pratica

Per la roadmap attuale del progetto:

1. **Non aggiungere traffico real-time ora.**
   - Complessità elevata, costi potenziali, dipendenze commerciali.
   - I vantaggi per un routing clinico/ambientale sono marginali rispetto alla qualità dell’aria, temperatura, pendenza.
2. **Valutare OSRM o Valhalla come sostituto/integrazione dell’A* su griglia.**
   - Migliora drasticamente la qualità dei percorsi.
   - Mantiene la logica di scoring ambientale come layer sopra il routing.
3. **Se in futuro si vuole il traffico:**
   - Iniziare con i free tier TomTom/HERE per aree di test.
   - Usare i dati come moltiplicatore di velocità sui segmenti del grafo OSRM.
   - Monitorare i costi prima di abilitarlo in produzione.

---

## 5. Risposte dirette alle domande

- **“Possiamo ottenere i dati sul traffico gratuitamente?”**
  - Sì, in modo limitato tramite free tier TomTom/HERE; non esiste una fonte open-source globale e stabile.

- **“Possiamo migliorare l’algoritmo per usare OpenStreetMap?”**
  - Sì, la strada migliore è integrare OSRM o Valhalla (grafi stradali reali) e applicare i pesi ambientali sulle geometrie restituite, oppure usare osmnx + A* custom se si vuole il pieno controllo.
