"""Weekly GLP-1 -> OnBase export (BRIDGE until full cutover to the new app).

Runs the OnBase-import query across dbo.ClaimsData_Prod: GLP-1 members (full drug
list) with a 2026+ date of service, matched to dbo.eligibility for MEMBER_ID, that
are NOT already in the OnBase outreach log (onbase.hsi.rmobjectinstance1032). One
row per member+NDC+drug at the latest date of service. Robust date parsing so
ISO-dated claims (e.g. July) are included, not silently dropped by style 101.

Builds a CSV and emails it as an attachment to the OnBase load team so they can
import the new GLP-1 records. Sends only when there are rows.

Env: IRX_DB_PWD, SMTP_HOST/PORT/USER/SMTP_PASS/MAIL_FROM,
     GLP1_ONBASE_TO (default techsupport@workflowinnovators.com)
"""
import io
import os
import csv
import smtplib
from datetime import date
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.application import MIMEApplication

import pyodbc

TO = os.environ.get("GLP1_ONBASE_TO", "techsupport@workflowinnovators.com")
HEADER = ["Group_Code", "Group_Name", "Member_ID", "Claim_Patient_ID", "Last_Name",
          "First_Name", "Date_of_Service", "NDC", "Drug_Name"]
GLP1 = ["ozemp", "wegov", "rybelsus", "semaglu", "mounjaro", "zepbound", "tirze", "trulicity",
        "dulaglutide", "victoza", "saxenda", "liraglutide", "byetta", "bydureon", "exenatide",
        "adlyxin", "lixisenatide", "soliqua", "xultophy"]


def db():
    driver = os.environ.get("SQLSERVER_ODBC_DRIVER", "ODBC Driver 17 for SQL Server")
    return pyodbc.connect(
        f"DRIVER={{{driver}}};SERVER=tcp:74.117.224.152,1433;DATABASE={os.environ.get('SQLSERVER_DB','iRx')};"
        f"UID=claudeservices;PWD={os.environ['IRX_DB_PWD']};Encrypt=yes;TrustServerCertificate=yes;Connection Timeout=30",
        autocommit=True)


def rd(col):
    # robust date, explicit styles only (no locale-dependent generic convert):
    # US m/d/yyyy (101), then ISO date / ISO datetime via LEFT(10) + style 23.
    return f"COALESCE(TRY_CONVERT(date,{col},101),TRY_CONVERT(date,LEFT({col},10),23))"


def query(cur):
    likes = " OR ".join(f"a.drugname LIKE '%{k}%'" for k in GLP1)
    # canonical client name per clientid (most-common), for a consistent Group_Name
    names = {}
    for r in cur.execute("SELECT REPLACE(LTRIM(RTRIM(clientid)),CHAR(39),'') cid, LTRIM(RTRIM(clientname)) nm, "
                         "COUNT(*) n FROM dbo.ClaimsData_Prod GROUP BY REPLACE(LTRIM(RTRIM(clientid)),CHAR(39),''), "
                         "LTRIM(RTRIM(clientname))"):
        if r[1] and (r[0] not in names or r[2] > names[r[0]][1]):
            names[r[0]] = (r[1], r[2])
    sql = f"""
    SELECT REPLACE(LTRIM(RTRIM(a.clientid)),CHAR(39),'') AS Group_Code, b.MEMBER_ID AS Member_ID,
           a.patientid AS Claim_Patient_ID, a.patientlastname AS Last_Name, a.patientfirstname AS First_Name,
           MAX({rd('a.dateofservice')}) AS Date_of_Service, a.ndc AS NDC, a.drugname AS Drug_Name
    FROM dbo.ClaimsData_Prod a
    JOIN dbo.eligibility b
       ON REPLACE(LTRIM(RTRIM(b.carrier)),CHAR(39),'') = REPLACE(LTRIM(RTRIM(a.clientid)),CHAR(39),'')
      AND LTRIM(RTRIM(b.LAST_NAME))  = LTRIM(RTRIM(a.patientlastname))
      AND LTRIM(RTRIM(b.FIRST_NAME)) = LTRIM(RTRIM(a.patientfirstname))
      AND {rd('b.DATE_OF_BIRTH')} = {rd('a.patientdateofbirth')}
    WHERE {rd('a.dateofservice')} >= '2026-01-01' AND ({likes})
      AND NOT EXISTS (
          SELECT 1 FROM onbase.hsi.rmobjectinstance1032 x
          WHERE REPLACE(LTRIM(RTRIM(x.attr1563)),CHAR(39),'') = REPLACE(LTRIM(RTRIM(a.clientid)),CHAR(39),'')
            AND {rd('x.attr1569')} = {rd('a.dateofservice')}
            AND LTRIM(RTRIM(x.attr1565)) = LTRIM(RTRIM(a.patientid))
            AND LTRIM(RTRIM(x.attr1571)) = LTRIM(RTRIM(a.drugname)))
    GROUP BY REPLACE(LTRIM(RTRIM(a.clientid)),CHAR(39),''), b.MEMBER_ID, a.patientid,
             a.patientlastname, a.patientfirstname, a.ndc, a.drugname
    ORDER BY 1, Last_Name, First_Name
    """
    rows = cur.execute(sql).fetchall()

    def c(v):
        return "" if v is None else str(v).strip()

    def mdy(v):
        return f"{v.month}/{v.day}/{v.year}" if hasattr(v, "year") else c(v)

    out = []
    for r in rows:
        gc = c(r[0])
        out.append([gc, names.get(gc, (gc,))[0], c(r[1]), c(r[2]), c(r[3]), c(r[4]), mdy(r[5]), c(r[6]), c(r[7])])
    return out


def to_csv(rows):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(HEADER)
    w.writerows(rows)
    return buf.getvalue().encode("utf-8-sig")


def send(csv_bytes, n, fname):
    from collections import Counter
    msg = MIMEMultipart()
    msg["Subject"] = f"ACTION: Load {n} new GLP-1 record(s) to OnBase — {date.today():%m/%d/%Y}"
    msg["From"] = os.environ["MAIL_FROM"]
    msg["To"] = TO
    body = (f"<p>The weekly GLP-1 &rarr; OnBase export identified <b>{n}</b> new GLP-1 member(s) "
            f"(matched to eligibility, not already in OnBase) this week.</p>"
            f"<p><b>Action:</b> please import the attached CSV "
            f"(<code>{fname}</code>) into OnBase for outreach.</p>"
            f"<p style='color:#64748b;font-size:12px'>Automated bridge process (True Path Monday load) "
            f"&mdash; runs until full cutover to the new app.</p>")
    msg.attach(MIMEText(body, "html"))
    part = MIMEApplication(csv_bytes, Name=fname)
    part["Content-Disposition"] = f'attachment; filename="{fname}"'
    msg.attach(part)
    recips = [a.strip() for a in TO.split(",") if a.strip()]
    with smtplib.SMTP(os.environ.get("SMTP_HOST", "smtp.office365.com"), int(os.environ.get("SMTP_PORT", "587"))) as s:
        s.starttls()
        s.login(os.environ["SMTP_USER"], os.environ["SMTP_PASS"])
        s.sendmail(msg["From"], recips, msg.as_string())


def main():
    cn = db()
    rows = query(cn.cursor())
    n = len(rows)
    if not n:
        print("GLP-1 OnBase export: 0 new records — no email sent.")
        return
    fname = f"GLP1_OnBase_import_{date.today():%Y%m%d}.csv"
    send(to_csv(rows), n, fname)
    print(f"GLP-1 OnBase export: emailed {n} record(s) to {TO} (attachment {fname}).")


if __name__ == "__main__":
    main()
