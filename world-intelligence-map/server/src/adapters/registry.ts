/**
 * Machine-readable registry of every source adapter. Adding a source = adding its directory and one line here.
 * `npm run manifest` exports the combined manifests to docs/sources.manifest.json.
 */
import type { SourceAdapter } from '../core/types.ts';
import emscEarthquakes from './emsc-earthquakes/adapter.ts';
import gdacs from './gdacs/adapter.ts';
import gvpHoloceneVolcanoes from './gvp-holocene-volcanoes/adapter.ts';
import gvpWeeklyReport from './gvp-weekly-report/adapter.ts';
import ibtracs from './ibtracs/adapter.ts';
import nasaEonet from './nasa-eonet/adapter.ts';
import nasaFirms from './nasa-firms/adapter.ts';
import noaaNhc from './noaa-nhc/adapter.ts';
import noaaTsunami from './noaa-tsunami/adapter.ts';
import usgsEarthquakes from './usgs-earthquakes/adapter.ts';
import aviationSigmet from './aviation-sigmet/adapter.ts';
import nwsAlerts from './nws-alerts/adapter.ts';
import openMeteoAirQuality from './open-meteo-air-quality/adapter.ts';
import openMeteoWeather from './open-meteo-weather/adapter.ts';
import openaq from './openaq/adapter.ts';
import hdxHapi from './hdx-hapi/adapter.ts';
import reliefweb from './reliefweb/adapter.ts';
import unhcrPopulation from './unhcr-population/adapter.ts';
import acled from './acled/adapter.ts';
import gdeltEvents from './gdelt-events/adapter.ts';
import digitrafficAis from './digitraffic-ais/adapter.ts';
import naturalEarthPorts from './natural-earth-ports/adapter.ts';
import opensky from './opensky/adapter.ts';
import ourairports from './ourairports/adapter.ts';
import cisaKev from './cisa-kev/adapter.ts';
import cloudflareRadar from './cloudflare-radar/adapter.ts';
import ioda from './ioda/adapter.ts';
import ooni from './ooni/adapter.ts';
import ripestatRouting from './ripestat-routing/adapter.ts';
import peeringdb from './peeringdb/adapter.ts';
import wriPowerPlants from './wri-power-plants/adapter.ts';
import whoDon from './who-don/adapter.ts';
import worldbankIndicators from './worldbank-indicators/adapter.ts';
import celestrak from './celestrak/adapter.ts';
import jplFireballs from './jpl-fireballs/adapter.ts';
import launchLibrary from './launch-library/adapter.ts';
import noaaSwpc from './noaa-swpc/adapter.ts';
import naturalEarth from './natural-earth/adapter.ts';
import tectonicPlates from './tectonic-plates/adapter.ts';
import unescoWorldHeritage from './unesco-world-heritage/adapter.ts';

export const ADAPTERS: SourceAdapter[] = [
  // hazards
  emscEarthquakes,
  gdacs,
  gvpHoloceneVolcanoes,
  gvpWeeklyReport,
  ibtracs,
  nasaEonet,
  nasaFirms,
  noaaNhc,
  noaaTsunami,
  usgsEarthquakes,
  // weather
  aviationSigmet,
  nwsAlerts,
  openMeteoAirQuality,
  openMeteoWeather,
  openaq,
  // humanitarian
  hdxHapi,
  reliefweb,
  unhcrPopulation,
  // geopolitics
  acled,
  gdeltEvents,
  // transport
  digitrafficAis,
  naturalEarthPorts,
  opensky,
  ourairports,
  // cyber
  cisaKev,
  cloudflareRadar,
  ioda,
  ooni,
  ripestatRouting,
  // infrastructure
  peeringdb,
  wriPowerPlants,
  // society
  whoDon,
  worldbankIndicators,
  // space
  celestrak,
  jplFireballs,
  launchLibrary,
  noaaSwpc,
  // reference
  naturalEarth,
  tectonicPlates,
  unescoWorldHeritage,
];
