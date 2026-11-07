"""Parse official U.S. economic release schedules into UTC event times."""

from datetime import datetime, time, timedelta, timezone
from html import unescape
import re
from zoneinfo import ZoneInfo

FOMC_URL = "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm"
FOMC_TIME_URL = "https://www.federalreserve.gov/economy-at-a-glance-policy-rate.htm"
FRED_CALENDAR = "https://fred.stlouisfed.org/releases/calendar"
EASTERN = ZoneInfo("America/New_York")
CENTRAL = ZoneInfo("America/Chicago")
RELEASES = {
    "calendarCpi": (10, "INFLATION", "소비자물가지수 (CPI)"),
    "calendarLabor": (50, "LABOR", "미국 고용보고서 (NFP)"),
}


def release_stamp(day, clock, zone):
    return datetime.combine(day, clock, zone).astimezone(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")


def parse_fomc(html, year):
    events = []
    sections = re.split(r'<h4>\s*<a\b[^>]*>\s*(20\d{2}) FOMC Meetings\s*</a>\s*</h4>', html)
    for section_year, section in zip(sections[1::2], sections[2::2]):
        if int(section_year) not in (year, year + 1):
            continue
        meetings = re.findall(
            r'fomc-meeting__month[^"]*"[^>]*>\s*<strong>\s*([^<]+?)\s*</strong>\s*</div>\s*'
            r'<div\b[^>]*fomc-meeting__date[^>]*>\s*(\d{1,2})\s*[-–]\s*(\d{1,2})\s*\*?\s*</div>',
            section,
        )
        for month, first, last in meetings:
            months = [item.strip() for item in unescape(month).split("/")]
            first_day = datetime.strptime(f"{section_year} {months[0][:3]} {first}", "%Y %b %d").date()
            last_day = datetime.strptime(f"{section_year} {months[-1][:3]} {last}", "%Y %b %d").date()
            if last_day != first_day + timedelta(days=1):
                raise ValueError("FOMC meeting date range could not be verified")
            # The Fed publishes regular decisions at 2:00 p.m. Eastern on day two.
            events.append({"name": "FOMC 금리 결정", "category": "FED", "date": first_day.isoformat(),
                           "releaseDate": last_day.isoformat(), "releaseAt": release_stamp(last_day, time(14), EASTERN),
                           "source": "calendarFomc", "sourceUrl": FOMC_URL, "timeSourceUrl": FOMC_TIME_URL})
    if not events:
        raise ValueError("No dated regular FOMC meetings found")
    return events


def parse_fred_calendar(html, year, key):
    release_id, category, name = RELEASES[key]
    if "All times are US Central Time" not in html:
        raise ValueError("FRED calendar timezone missing")
    if "No release dates are available for the selected options." in html:
        return []
    events = []
    day = None
    for row in re.findall(r"<tr\b[^>]*>(.*?)</tr>", html, re.S):
        date_cell = re.search(r">\s*([A-Z][a-z]+ [A-Z][a-z]+ \d{1,2}, \d{4})\s*</span>", row)
        if date_cell:
            day = datetime.strptime(date_cell[1], "%A %B %d, %Y").date()
        if f'href="/release?rid={release_id}"' not in row:
            continue
        clock = re.search(r"<td\b[^>]*>\s*(\d{1,2}:\d{2}\s*[ap]m)\s*</td>", row, re.I)
        if day is None or day.year != year or clock is None:
            raise ValueError("FRED release date or time could not be verified")
        scheduled = datetime.strptime(clock[1].upper(), "%I:%M %p").time()
        events.append({"name": name, "category": category, "date": day.isoformat(),
                       "releaseAt": release_stamp(day, scheduled, CENTRAL), "source": key,
                       "sourceUrl": f"{FRED_CALENDAR}?rid={release_id}&y={year}"})
        day = None
    if not events:
        raise ValueError("FRED schedule returned no matching release rows")
    return events


def validate_calendar(events):
    if not isinstance(events, list):
        raise ValueError("Macro calendar must be a list")
    seen = set()
    for event in events:
        key = event["source"]
        start = datetime.strptime(event["date"], "%Y-%m-%d").date()
        published = datetime.strptime(event["releaseAt"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
        if key == "calendarFomc":
            local = published.astimezone(EASTERN)
            expected = ("FED", "FOMC 금리 결정", FOMC_URL)
            if (event["releaseDate"] != local.date().isoformat() or local.date() != start + timedelta(days=1)
                    or local.time() != time(14)):
                raise ValueError("Invalid FOMC release timestamp")
        else:
            release_id, category, name = RELEASES[key]
            expected = (category, name, f"{FRED_CALENDAR}?rid={release_id}&y={start.year}")
            if published.astimezone(CENTRAL).date() != start:
                raise ValueError("Invalid FRED release timestamp")
        identity = (key, published)
        if (event["category"], event["name"], event["sourceUrl"]) != expected or identity in seen:
            raise ValueError("Invalid or duplicate macro calendar event")
        seen.add(identity)
