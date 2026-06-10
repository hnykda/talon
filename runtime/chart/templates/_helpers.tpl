{{/*
Expand the name of the chart.
*/}}
{{- define "talon.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Create a default fully qualified app name (63 char limit per DNS spec).
*/}}
{{- define "talon.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{/*
Chart name and version label.
*/}}
{{- define "talon.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/*
Common labels
*/}}
{{- define "talon.labels" -}}
helm.sh/chart: {{ include "talon.chart" . }}
{{ include "talon.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{/*
Selector labels
*/}}
{{- define "talon.selectorLabels" -}}
app.kubernetes.io/name: {{ include "talon.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{/*
Secret name: with release name "talon" this is "talon-secrets".
*/}}
{{- define "talon.secretName" -}}
{{- if .Values.existingSecret }}
{{- .Values.existingSecret }}
{{- else }}
{{- printf "%s-secrets" (include "talon.fullname" .) }}
{{- end }}
{{- end }}

{{/*
PVC name
*/}}
{{- define "talon.pvcName" -}}
{{- printf "%s-home" (include "talon.fullname" .) }}
{{- end }}

{{/*
ServiceAccount name
*/}}
{{- define "talon.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "talon.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}
