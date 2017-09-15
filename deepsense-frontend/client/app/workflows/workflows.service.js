'use strict';

/* @ngInject */
function WorkflowService($rootScope, Workflow, OperationsHierarchyService, WorkflowsApiClient, Operations, ConfirmationModalService,
  DefaultInnerWorkflowGenerator, debounce, nodeTypes, SessionManagerApi, SessionStatus, SessionManager, ServerCommunication) {

  const INNER_WORKFLOW_PARAM_NAME = 'inner workflow';

  class WorkflowServiceClass {

    constructor() {
      this._workflowsStack = [];
      this._innerWorkflowByNodeId = {};
      // We want to save workflow after all intermediate changes are resolved. Intermediate state might be invalid.
      // Debounce takes care of that and additionally reduces unnecessary client-server communication.
      // Example:
      // Inner workflow has nodes and publicParam list. Public params point at specific nodes.
      // Let's say we are removing node with public params. This change gets propagated to publicParam list next
      // digest cycle. For one digest cycle state is invalid - public params list points non-existing node.
      this._saveWorkflow = debounce((serializedWorkflow) => {
        console.log('Saving workflow after change...', serializedWorkflow);
        WorkflowsApiClient.updateWorkflow(serializedWorkflow);
      }, 200);

      $rootScope.$on('AttributesPanel.OPEN_INNER_WORKFLOW', (event, data) => {
        let workflow = this._innerWorkflowByNodeId[data.nodeId];
        this._workflowsStack.push(workflow);
      });

      $rootScope.$on('StatusBar.CLOSE-INNER-WORKFLOW', () => {
        this._workflowsStack.pop();
      });
    }

    initRootWorkflow(workflowData) {
      this._workflowsStack = [];
      let workflow = this._deserializeWorkflow(workflowData);
      workflow.workflowType = 'root';
      workflow.workflowStatus = 'editor';
      workflow.sessionStatus = SessionStatus.NOT_RUNNING;

      workflow.owner = {
        id: workflowData.workflowInfo.ownerId,
        name: workflowData.workflowInfo.ownerName
      };

      let nodes = _.values(workflow.getNodes());
      nodes.filter((n) => n.operationId === nodeTypes.CUSTOM_TRANSFORMER)
        .forEach((node) => this.initInnerWorkflow(node, workflow));

      $rootScope.$watch(() => workflow.serialize(), this._saveWorkflow, true);
      $rootScope.$watch(() => SessionManager.statusForWorkflowId(workflow.id), (newStatus) => {
        workflow.sessionStatus = newStatus;
      });

      $rootScope.$on('StatusBar.START_EDITING', () => {
        const workflow = this.getRootWorkflow();
        SessionManagerApi.startSession(workflow.id);
      });

      $rootScope.$on('StatusBar.STOP_EDITING', () => {
        ConfirmationModalService.showModal({
          message: 'Are you sure you want to stop executor? Cached reports will disappear.'
        }).then(() => {
          const workflow = this.getRootWorkflow();
          SessionManagerApi.deleteSessionById(workflow.id);
        });
      });

      this._watchForNewCustomTransformers(workflow, workflow);
      this._workflowsStack.push(workflow);

      const unregisterSynchronization = $rootScope.$on('ServerCommunication.MESSAGE.heartbeat', (event, data) => {
        if (data.sessionId === workflow.id) {
          console.log('Received first hearbeat. Synchronizing with executor...');
          ServerCommunication.sendSynchronize();
          unregisterSynchronization();
        }
      });
    }

    // TODO Add enums for workflowType, workflowStatus
    initInnerWorkflow(node, rootWorkflow) {
      let innerWorkflowData = node.parametersValues[INNER_WORKFLOW_PARAM_NAME];
      let innerWorkflow = this._deserializeInnerWorkflow(innerWorkflowData);
      innerWorkflow.workflowType = 'inner';
      innerWorkflow.workflowStatus = 'editor';
      innerWorkflow.sessionStatus = SessionStatus.NOT_RUNNING;
      innerWorkflow.owner = rootWorkflow.owner;

      innerWorkflow.publicParams = innerWorkflow.publicParams || [];
      this._innerWorkflowByNodeId[node.id] = innerWorkflow;

      let nestedCustomTransformerNodes = _.filter(_.values(innerWorkflow.getNodes()), (n) => n.operationId === nodeTypes.CUSTOM_TRANSFORMER);
      _.forEach(nestedCustomTransformerNodes, (node) => this.initInnerWorkflow(node, rootWorkflow));

      $rootScope.$watch(() => SessionManager.statusForWorkflowId(rootWorkflow.id), (newStatus) => {
        innerWorkflow.sessionStatus = newStatus;
      });

      $rootScope.$watch(() => this._serializeInnerWorkflow(innerWorkflow), (newVal) => {
        node.parametersValues = node.parametersValues || {};
        node.parametersValues[INNER_WORKFLOW_PARAM_NAME] = newVal;
      }, true);

      this._watchForNewCustomTransformers(innerWorkflow, rootWorkflow);
    }

    _watchForNewCustomTransformers(workflow, rootWorkflow) {
      $rootScope.$watchCollection(() => workflow.getNodes(), (newNodes, oldNodes) => {
        let addedNodeIds = _.difference(_.keys(newNodes), _.keys(oldNodes));
        let addedNodes = _.map(addedNodeIds, nodeId => newNodes[nodeId]);
        let addedCustomWorkflowNodes = _.filter(addedNodes, (n) => n.operationId === nodeTypes.CUSTOM_TRANSFORMER);
        _.forEach(addedCustomWorkflowNodes, (addedNode) => {
          if (_.isUndefined(addedNode.parametersValues[INNER_WORKFLOW_PARAM_NAME])) {
            addedNode.parametersValues[INNER_WORKFLOW_PARAM_NAME] = DefaultInnerWorkflowGenerator.create();
          }
          this.initInnerWorkflow(addedNode, rootWorkflow);
        });
      });
    }

    _getRootWorkflowsWithInnerWorkflows() {
      const innerWorkflows = _.values(this._innerWorkflowByNodeId);
      return [this.getRootWorkflow()].concat(innerWorkflows);
    }

    _serializeInnerWorkflow(workflow) {
      let workflowData = workflow.serialize();
      workflowData.publicParams = workflow.publicParams;
      return workflowData;
    }

    _deserializeInnerWorkflow(workflowData) {
      let workflow = this._deserializeWorkflow(workflowData);
      workflow.publicParams = workflowData.publicParams || [];
      return workflow;
    }

    _deserializeWorkflow(workflowData) {
      let operations = Operations.getData();
      let workflow = new Workflow();
      let thirdPartyData = workflowData.thirdPartyData || {};
      workflow.id = workflowData.id;
      workflow.name = (thirdPartyData.gui || {}).name;
      workflow.description = (thirdPartyData.gui || {}).description;
      workflow.predefColors = (thirdPartyData.gui || {}).predefColors || workflow.predefColors;
      workflow.createNodes(workflowData.workflow.nodes, operations, workflowData.thirdPartyData);
      workflow.createEdges(workflowData.workflow.connections);
      workflow.updateEdgesStates(OperationsHierarchyService);
      return workflow;
    }

    isWorkflowRunning() {
      let statuses = _.chain(this.getCurrentWorkflow().getNodes())
        .map((node) => {
          return node.state && node.state.status;
        })
        .value();
      let idx = _.findIndex(statuses, (status) => {
        return status === 'status_queued' || status === 'status_running';
      });

      return idx !== -1;
    }

    getCurrentWorkflow() {
      return _.last(this._workflowsStack);
    }

    onInferredState(states) {
      this._getRootWorkflowsWithInnerWorkflows().forEach(w => w.updateState(states));
    }

    clearGraph() {
      this.getCurrentWorkflow().clearGraph();
    }

    updateTypeKnowledge(knowledge) {
      this._getRootWorkflowsWithInnerWorkflows().forEach(w => w.updateTypeKnowledge(knowledge));
    }

    updateEdgesStates() {
      this.getCurrentWorkflow().updateEdgesStates(OperationsHierarchyService);
    }

    getRootWorkflow() {
      return this._workflowsStack[0];
    }

    getAllWorkflows() {
      return this._workflowsData;
    }

    removeWorkflowFromList(workflowId) {
      let foundWorkflow = this._workflowsData.find((workflow) => workflow.id === workflowId);
      let workflowIndex = this._workflowsData.indexOf(foundWorkflow);
      if (workflowIndex >= 0) {
        this._workflowsData.splice(workflowIndex, 1);
      }
    }

    deleteWorkflow(workflowId) {
      WorkflowsApiClient.deleteWorkflow(workflowId).then(() => {
        this.removeWorkflowFromList(workflowId);
      });
    }

    downloadWorkflow(workflowId) {
      return WorkflowsApiClient.getWorkflow(workflowId);
    }

    downloadWorkflows() {
      return WorkflowsApiClient.getAllWorkflows().then((workflows) => {
        this._workflowsData = workflows; // TODO There should be no state here. Get rid of it
        return workflows;
      });
    }
  }

  return new WorkflowServiceClass();
}

exports.function = WorkflowService;

exports.inject = function (module) {
  module.factory('WorkflowService', WorkflowService);
};
