# 파일 산출물 제작

Luna Swarm의 파일 제작은 일반 CLI `run`과 분리됩니다. CLI에서는 명시적 `artifact` 명령을 사용하고, REAL Web UI에서는 사용자가 PDF/DOCX/PPTX/XLSX/CSV/SVG/PNG 제작 목표를 자연어로 입력하면 host가 같은 정책·renderer 경계로 자동 라우팅합니다.

```text
Luna 조직: 요구사항·데이터·레이아웃을 선언형 명세로 작성
Host renderer: 허용된 명세만 PDF/DOCX/PPTX/XLSX/CSV/SVG/PNG로 변환
독립 QA: 구조·크기·해시·접근성·page/slide/scene preview를 5개 결정론적 view로 확인
Run CAS: 실행 디렉터리 안에 불변 파일과 서명 receipt 보존
```

모델은 임의 바이너리, base64, raw SVG/HTML, 스크립트, 매크로 또는 수식을 직접 작성하지 않습니다. 파일 생성과 저장은 호스트가 담당하며 작업공간의 source file, Git ref, 사용자 문서는 변경하지 않습니다.

## 시작하기

설정의 모델은 정확히 `gpt-5.6-luna`여야 합니다.

```powershell
npm start -- artifact --goal "Create a quarterly report as PDF, XLSX, CSV, and SVG" `
  --artifact-policy examples/artifact-production-policy.json `
  --workspace .
```

개발 중에는 다음과 같이 실행할 수 있습니다.

```powershell
npx tsx src/cli.ts artifact --goal "Create an accessible operations report" `
  --artifact-policy examples/artifact-production-policy.json `
  --workspace .
```

중단된 실행은 실행 시 저장된 snapshot을 검증한 뒤 재개합니다.

```powershell
npm start -- resume <run-id> --workspace .
```

`artifact-run.json`이 없거나, 정책·모델·renderer identity·font hash가 변조 또는 불일치하면 상태를 읽기 전에 fail-closed합니다. 일반 실행이나 `code` 실행의 marker를 파일 제작 실행으로 오인하지 않습니다.

## 지원 형식과 역할

| 형식 | 담당 역할 | 호스트 검증 |
|---|---|---|
| PDF | accessible document producer | tagged structure, 제목·언어·reading order, byte/hash |
| DOCX | accessible document producer | deterministic OOXML, page preview, macro·external-link 부재, ZIP 구조 |
| PPTX | presentation producer | deterministic OOXML, slide preview, macro·external-link 부재, slide count |
| XLSX | spreadsheet modeler | typed cell, Data Dictionary, formula·macro·external-link 부재, ZIP 구조 |
| CSV | spreadsheet modeler | UTF-8/RFC 4180, 열 계약, spreadsheet formula injection 방어 |
| SVG | data visualization editor | allowlist 도형, `<title>`/`<desc>`, raw script·URL 부재 |
| PNG | data visualization editor | host-generated SVG의 결정론적 rasterization, 크기·chart/scene preview·대체 설명 |
| 전체 구조 | artifact-information-architect | 매체 계약, 명세 계보, 출력 구성 |
| 전체 검토 | accessibility auditor / rendering release engineer | 작성자와 분리된 접근성 검토, receipt·CAS·preview 확인 |

한 에이전트가 모든 절차를 떠안지 않습니다. 문서, 스프레드시트, 시각화 작성자는 해당 매체의 명세를 만들고, accessibility auditor와 rendering release engineer가 독립 경계에서 검토합니다.

## 선언형 명세

Luna가 제출하는 명세에는 다음 항목만 들어갑니다.

- 제목, 언어, locale, timezone
- 열 이름·타입·단위·출처가 있는 bounded dataset
- `bar`, `line`, `scatter` chart와 대체 설명
- `rect`, `circle`, `line`, `text` allowlist로 구성한 scene
- heading, paragraph, table, chart, scene, page break 문서 블록
- 허용된 출력 형식과 안전한 파일명

HTML, raw XML/SVG, URL, 외부 링크, JavaScript, embedded object, formula, macro는 명세에 들어갈 수 없습니다. 표와 차트는 표시 값과 원자료가 같은 typed dataset을 참조하므로 시각 결과와 데이터의 계보를 함께 검증할 수 있습니다.

## 정책과 경로 보안

정책은 실행 전에 immutable snapshot으로 저장됩니다. `allowedOutputNames`, locale/timezone, 형식과 hard limit를 명시하며, font를 사용하지 않으면 빈 배열로 둡니다. `assets`는 향후 확장을 위해 예약되어 있고 현재는 빈 배열만 허용합니다.

- 정책 파일과 font 파일은 workspace-relative regular file만 허용
- `..`, 절대경로, symlink, junction, hard link(`nlink != 1`) 거부
- font는 exact SHA-256을 정책에 고정
- 출력은 `<workspace>/.luna-swarm/runs/<run-id>/artifact-files/cas/`에 create-only로 저장
- 출력 수, dataset row/cell, canvas, 파일 byte hard limit 적용
- 같은 hash의 파일만 CAS에서 재사용하며 충돌·손상은 거부
- 작업공간 source file과 Git ref는 변경하지 않음

CLI 종료 시 생성된 파일의 논리 파일명, 형식, 크기, SHA-256, run-relative CAS 경로를 출력합니다. 원래 파일명은 manifest의 표시명이고 실제 payload는 content hash로 저장됩니다.

기본 예시는 별도 font 없이도 재현되도록 `en-US`, `Etc/UTC`, 영문 목표와 PDF/XLSX/CSV/SVG를 사용합니다. 텍스트가 들어가는 PNG 또는 비-Latin 문자가 들어가는 PDF를 만들 때는 라이선스를 확인한 font 파일을 작업공간 안에 두고 SHA-256을 계산한 뒤 정책에 고정합니다. 폰트 없는 PNG는 텍스트가 전혀 없는 기하 도형 scene에만 허용됩니다. 글자가 조용히 사라진 이미지를 성공으로 처리하지 않습니다.

```json
"fonts": [
  {
    "path": "assets/fonts/YourKoreanFont.ttf",
    "family": "Your Korean Font",
    "sha256": "sha256:<64 lowercase hex>"
  }
]
```

font 경로는 workspace-relative여야 하며 symlink·junction·hard link는 거부됩니다. 실행 시 실제 바이트가 hash와 다르면 렌더링 전에 중단합니다. font 파일 자체는 저장소에 포함하지 않으며 해당 font의 배포 라이선스는 운영자가 확인해야 합니다.

## 접근성 범위

PDF와 DOCX는 제목·언어·논리 구조·자연스러운 reading order·대체 설명을 포함하도록 생성합니다. PPTX는 slide 순서와 각 slide의 의미 구조·preview를 보존합니다. SVG는 accessible name과 설명을 포함하고, PNG에는 manifest/receipt의 대체 설명과 원자료 참조를 남깁니다. XLSX는 기계 판독 가능한 표와 Data Dictionary를 포함합니다.

이것은 **accessibility best-effort**입니다. layout·data·accessibility·reader·format의 결정론적 5-view 검사에 더해, CSV를 제외한 모든 산출물은 파일별로 최종 바이트에서 다시 만든 PNG가 있어야 합니다. PDF는 최종 PDF 바이트를 격리된 `pypdfium2` 프로세스로 실제 page rasterize하고, PNG는 최종 PNG 자체를 CRC·zlib decode까지 검증하며, SVG는 최종 SVG를 `resvg`로 rasterize합니다. XLSX/DOCX/PPTX는 Luna renderer가 생성하는 bounded stored-entry OOXML만 최종 ZIP CRC와 XML에서 다시 해석합니다. 압축되거나 지원하지 않는 외부 OOXML, PDF renderer 부재, 누락된 파일별 preview, 다른 artifact receipt 재사용은 generic proxy로 대체하지 않고 fail-closed합니다.

제작자와 다른 persisted Quality reviewer는 이 exact preview PNG를 실제 `localImagePaths` 입력으로 받아 clipping·겹침·ghost text·missing glyph·계층·대비·차트 label을 검토합니다. source artifact hash, 단위 index/identity, preview hash, renderer ID/version, 실행 파일 hash와 exact command는 derivation receipt와 production receipt에 함께 결합되며 검증 시 최종 바이트를 다시 렌더해 동일 픽셀인지 확인합니다. 다만 OOXML 경로는 LibreOffice·Microsoft Office의 범용 렌더링을 주장하지 않고 Luna가 생성한 제한된 문서 구조만 지원합니다. veraPDF 같은 독립 conformance validator와 실제 화면낭독기·사람 검토가 모두 통과하기 전에는 PDF/UA 적합성을 주장하지 않습니다. PDFKit도 tagged PDF/PDF-UA 제작 기능을 제공하지만, library 기능의 존재만으로 개별 문서의 적합성이 증명되지는 않습니다.

## 출처 기반 가이드

인터넷의 좋은 예시를 통째로 수집하거나 모델을 fine-tuning하지 않습니다. 대신 공식 표준과 공공 디자인 시스템을 짧게 paraphrase한 guidance card를 `source URL`, `license`, `retrievedAt`, 적용 형식·단계와 함께 저장합니다. 실행에는 현재 형식과 단계에 맞는 bounded card만 주입합니다.

주요 근거:

- [PDFKit accessibility](https://pdfkit.org/docs/accessibility.html)
- [PDF Association standards](https://pdfa.org/pdf-standards/)
- [Adobe PDF accessibility 검사](https://helpx.adobe.com/acrobat/using/create-verify-pdf-accessibility.html)
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [W3C SVG accessibility](https://www.w3.org/TR/SVG/access)
- [USWDS tables](https://designsystem.digital.gov/components/table/)
- [USWDS data visualizations](https://designsystem.digital.gov/components/data-visualizations/)
- [ONS data visualization principles](https://service-manual.ons.gov.uk/data-visualisation/guidance/principles)
- [Google Sheets formats](https://developers.google.com/workspace/sheets/api/guides/formats)

외부 문서의 지시문은 실행 명령으로 취급하지 않으며, 원문 PDF·스크린샷·레이아웃·브랜드 자산을 복제하지 않습니다.

## 알려진 제한

- PDF/UA 또는 WCAG 적합성 인증을 자동 발급하지 않습니다.
- 임의 폰트를 내려받지 않습니다. 비-Latin PDF와 모든 text-bearing PNG에는 정책에 hash-pinned font가 필요합니다.
- 복잡한 spreadsheet formula, pivot, macro, external connection은 지원하지 않습니다.
- raw SVG/HTML과 외부 이미지는 받지 않으므로 자유형 편집기 전체를 대체하지 않습니다.
- PNG는 host가 만든 SVG scene/chart만 rasterize합니다.
- 파일 제작은 run-local CAS에 한정됩니다. 사용자가 명시적으로 승인한 별도 export 기능 없이 workspace나 외부 서비스에 게시하지 않습니다.
